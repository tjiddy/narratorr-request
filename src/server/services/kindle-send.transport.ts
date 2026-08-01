import { Readable, Transform, type TransformCallback } from 'node:stream';
import nodemailer from 'nodemailer';
import type { EmailRuntimeConfig } from './notifications/index.js';
import type {
  KindleSendFailureCode,
  KindleSendTerminalStatus,
} from '../../shared/schemas/ebooks.js';
import { MAX_KINDLE_SEND_BYTES } from './kindle-send.policy.js';

/**
 * The transport half of Send-to-Kindle (issue #148) — everything between "we have an upstream
 * byte stream" and "the SMTP transaction settled", kept PURE and separately testable so the
 * integrity rules and the rejection taxonomy are asserted as units rather than only through a
 * live socket.
 */

/**
 * A DEDICATED transport profile, distinct from `buildRequesterTransport`'s inline 10s/10s/20s —
 * those numbers are sized for a 2 KB notification, not a 25 MiB attachment.
 *
 * All three bound IDLE time only. `socketTimeout` in particular is an INACTIVITY timer (nodemailer
 * applies it via `socket.setTimeout`), NOT a throughput or total-duration bound: a peer that emits
 * one byte just inside each interval resets it indefinitely. Total duration is the attempt
 * deadline's job, and even that cannot bound the post-DATA window — see `KindleSendService`.
 */
export const KINDLE_SMTP_CONNECTION_TIMEOUT_MS = 15_000;
export const KINDLE_SMTP_GREETING_TIMEOUT_MS = 15_000;
export const KINDLE_SMTP_SOCKET_INACTIVITY_TIMEOUT_MS = 60_000;

/** The one media type an EPUB attachment is ever labelled with. */
export const EPUB_MEDIA_TYPE = 'application/epub+zip';

/**
 * FIXED message copy. No user-supplied text reaches the subject or the body — the caller's
 * `?title` only ever names the ATTACHMENT — and there is deliberately no `html` part at all, so
 * there is no HTML injection surface and no link to rewrite.
 */
export const KINDLE_SEND_SUBJECT = 'Send to Kindle';
export const KINDLE_SEND_TEXT = 'Your companion ebook is attached.';

// ---- The transport seam -----------------------------------------------------

/** One address as nodemailer echoes it back — a bare string, or a parsed mailbox. */
export type KindleSendAddress = string | { address?: string | undefined };

/** The slice of nodemailer's `SentMessageInfo` the success predicate reads. */
export interface KindleSendInfo {
  accepted?: ReadonlyArray<KindleSendAddress> | undefined;
  rejected?: ReadonlyArray<KindleSendAddress> | undefined;
}

/** The message shape this path builds — no `html`, no `cc`/`bcc`, no reply-to. */
export interface KindleMailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
  attachments: Array<{ filename: string; content: Readable; contentType: string }>;
}

/**
 * The injectable transport. Narrow on purpose: the service must be drivable by a fake that
 * fabricates `accepted`/`rejected` AND by the real nodemailer transport against a live SMTP
 * server, without either knowing about the other.
 */
export interface KindleTransport {
  sendMail(message: KindleMailMessage): Promise<KindleSendInfo>;
  close(): void;
}

export type KindleTransportFactory = (config: EmailRuntimeConfig) => KindleTransport;

/**
 * The transport options, as a value — so a test can assert the AC35 constants actually reach
 * nodemailer instead of asserting on a spy over a module default export. The auth block is omitted
 * for a passwordless / open-relay source, exactly as the requester-email path does.
 */
export function kindleTransportOptions(cfg: EmailRuntimeConfig): Record<string, unknown> {
  return {
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    connectionTimeout: KINDLE_SMTP_CONNECTION_TIMEOUT_MS,
    greetingTimeout: KINDLE_SMTP_GREETING_TIMEOUT_MS,
    socketTimeout: KINDLE_SMTP_SOCKET_INACTIVITY_TIMEOUT_MS,
    ...(cfg.user && cfg.pass ? { auth: { user: cfg.user, pass: cfg.pass } } : {}),
  };
}

/** A fresh, non-pooled nodemailer transport on the dedicated Kindle profile. */
export const buildKindleTransport: KindleTransportFactory = (cfg) => {
  const transport = nodemailer.createTransport(kindleTransportOptions(cfg));
  return {
    sendMail: (message) => transport.sendMail(message),
    close: () => transport.close(),
  };
};

// ---- Streaming & integrity --------------------------------------------------

/**
 * Adapt the upstream web stream to a Node `Readable` WITHOUT buffering it: exactly one upstream
 * `read()` per `_read()`, so backpressure from the SMTP socket reaches narratorr's socket and peak
 * retained memory is one chunk, not one EPUB. Chunks are wrapped as Buffer VIEWS (no copy).
 *
 * Hand-rolled rather than `Readable.fromWeb` so the cancel-on-destroy wiring is explicit: the
 * deadline destroys this stream, and that must cancel the upstream reader rather than leave a
 * socket draining into nothing.
 */
export function webStreamToReadable(body: ReadableStream<Uint8Array>): Readable {
  const reader = body.getReader();
  return new Readable({
    async read() {
      try {
        const { done, value } = await reader.read();
        if (done || value === undefined) this.push(null);
        else this.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
      } catch (err: unknown) {
        this.destroy(err instanceof Error ? err : new Error('upstream companion stream failed'));
      }
    },
    destroy(err, cb) {
      void reader.cancel().catch(() => {});
      cb(err);
    },
  });
}

/** The two failures OUR OWN integrity rules induce, as opposed to anything SMTP or narratorr did. */
export type CountingAbortReason = Extract<KindleSendFailureCode, 'oversize' | 'size_mismatch'>;

/**
 * The counting transform: the ONLY place raw EPUB bytes are measured, and the place both integrity
 * rules are enforced as PRE-COMPLETION ABORTS rather than post-hoc checks.
 *
 * • THE CAP is enforced on bytes actually seen, not only on the advertised `sizeBytes`, so a lying
 *   annotation cannot smuggle a larger payload. It trips at exactly `MAX + 1` — the counter is
 *   pinned there rather than absorbing a whole oversized chunk, so "counted bytes never exceed
 *   MAX + 1" is a property of the counter and not of the producer's chunking.
 * • INTEGRITY is checked in `_flush()`. Erroring there means the attachment never reaches EOF
 *   cleanly, so nodemailer's DATA cannot complete and the receiving server discards the partial —
 *   which is what makes "a truncated EPUB can never arrive as a successful email" true by
 *   construction rather than by a check we might forget to run.
 *
 * The comparison is against the advertised `sizeBytes`, NEVER the HTTP `Content-Length` (which is
 * informational on this path).
 */
export class CountingEpubStream extends Transform {
  private counted = 0;
  private aborted: CountingAbortReason | null = null;

  constructor(private readonly expectedBytes: number) {
    super();
  }

  /** Raw upstream bytes seen so far. Persisted onto the audit row once the attempt is terminal. */
  get bytes(): number {
    return this.counted;
  }

  /** Which of our own integrity rules aborted the stream, if either did. */
  get abortReason(): CountingAbortReason | null {
    return this.aborted;
  }

  /**
   * Whether the readable side actually reached `end` — i.e. the transport consumed EVERY attachment
   * byte AND `_flush()` passed. The STAGE discriminator the rejection taxonomy asks question 3
   * against; see {@link classifySendRejection}.
   *
   * Read from Node's own `readableEnded`, which flips exactly when the `end` event is emitted.
   * Deliberately NOT a flag set in `_flush()`: `_flush()` fires when the WRITABLE side has ended
   * and the final output has been queued, which says nothing about downstream consumption — up to
   * a full `highWaterMark` of attachment bytes can still be sitting in the readable buffer,
   * un-read by nodemailer and therefore never written to the socket. Using the `_flush()` moment
   * would classify a disconnect in that gap as `indeterminate` even though the message was never
   * submitted, suppressing a retry that is provably safe. It would also widen the deliberate
   * over-approximation from "the MIME epilogue plus the `\r\n.\r\n` terminator" to the whole
   * readable buffer, which is not the trade the contract makes.
   */
  get reachedEnd(): boolean {
    return this.readableEnded;
  }

  override _transform(chunk: Buffer | string, _encoding: BufferEncoding, cb: TransformCallback): void {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (buf.length > MAX_KINDLE_SEND_BYTES - this.counted) {
      this.counted = MAX_KINDLE_SEND_BYTES + 1;
      this.aborted = 'oversize';
      cb(new Error('companion ebook exceeded the maximum Send-to-Kindle size'));
      return;
    }
    this.counted += buf.length;
    cb(null, buf);
  }

  override _flush(cb: TransformCallback): void {
    // Integrity is enforced HERE — before EOF — so the attachment never ends cleanly on a mismatch
    // and nodemailer's DATA cannot complete. It deliberately does NOT record the submission stage:
    // that is `readableEnded`'s job, and the two moments are genuinely different.
    if (this.counted !== this.expectedBytes) {
      this.aborted = 'size_mismatch';
      cb(new Error('companion ebook byte count did not match the advertised size'));
      return;
    }
    cb();
  }
}

// ---- Outcome classification -------------------------------------------------

/** One terminal disposition: the durable status plus the safe failure code (null on `sent`). */
export interface KindleTerminalOutcome {
  status: KindleSendTerminalStatus;
  failureCode: KindleSendFailureCode | null;
}

/**
 * Did the server REPLY? The only observable the taxonomy reads off a nodemailer error.
 *
 * There is deliberately no error-code taxonomy: nodemailer raises at least nine distinct `code`
 * values and that set is not a closed union we may enumerate, while `_onClose` raises the same
 * `ECONNECTION`/`CONN` pair whether or not DATA completed. `responseCode` is different — it is
 * present exactly when the server sent us a reply line, which makes the outcome definitive.
 */
export function hasServerReply(err: unknown): boolean {
  return typeof (err as { responseCode?: unknown } | null | undefined)?.responseCode === 'number';
}

/** Normalize an `accepted`/`rejected` list to lowercased addresses. */
function addressList(list: ReadonlyArray<KindleSendAddress> | undefined): string[] {
  const out: string[] = [];
  for (const entry of list ?? []) {
    const address = typeof entry === 'string' ? entry : entry?.address;
    if (typeof address === 'string' && address !== '') out.push(address.toLowerCase());
  }
  return out;
}

/**
 * The success predicate for a RESOLVED `sendMail`: the caller's own stored Kindle address must be
 * in `accepted` AND absent from `rejected`. Compared case-insensitively — `users.kindle_email` is
 * stored trim+lowercased, while nodemailer echoes whatever the server returned. Empty `accepted`,
 * the address in `rejected`, and the address in neither all fail.
 */
export function sendMailAccepted(info: KindleSendInfo, recipient: string): boolean {
  const target = recipient.toLowerCase();
  return addressList(info.accepted).includes(target) && !addressList(info.rejected).includes(target);
}

/** What the classifier knows about how far the attempt got when the rejection landed. */
export interface KindleSendStage {
  /** The transform's readable side reached `end`. */
  reachedEnd: boolean;
  /** Our own byte cap / integrity check aborted the attachment. */
  abortReason: CountingAbortReason | null;
  /** The upstream body errored mid-stream. */
  upstreamErrored: boolean;
}

/**
 * Classify a REJECTED `sendMail` (AC40 questions 2 and 3, AC41 rows 3–6 and 9–10).
 *
 * Question 3 is a TOTAL else-branch keyed purely on stage, which is what makes the table
 * exhaustive by construction: an `EAUTH` (which rejects before a single attachment byte is
 * consumed) lands on `failed` through the same rule as a dropped socket, and an unknown future
 * nodemailer code cannot fall outside it. Rows 4–6 refine only the CODE of the catch-all rows,
 * never the status they assign.
 *
 * Stage-based classification over-approximates `indeterminate` by the width of the MIME epilogue
 * plus the `\r\n.\r\n` terminator. That direction is chosen deliberately: `indeterminate` MEANS
 * "we don't know", is never auto-retried and holds replay suppression, whereas calling a genuinely
 * submitted message `failed` invites a retry and lands two copies in the user's Kindle library.
 */
export function classifySendRejection(err: unknown, stage: KindleSendStage): KindleTerminalOutcome {
  // Q2 — the server replied, so the outcome is definitive regardless of stage (row 3).
  if (hasServerReply(err)) return { status: 'failed', failureCode: 'smtp_rejected' };
  // Q3 — no reply: stage decides. Reached `end` means the transport consumed everything (row 10).
  if (stage.reachedEnd) return { status: 'indeterminate', failureCode: null };
  if (stage.abortReason) return { status: 'failed', failureCode: stage.abortReason }; // rows 4 / 5
  if (stage.upstreamErrored) return { status: 'failed', failureCode: 'upstream_unavailable' }; // row 6
  return { status: 'failed', failureCode: 'smtp_error' }; // row 9
}

/**
 * The deadline's disposition (AC41 rows 7 and 8). Reached `end` means the bytes were all handed
 * over and only the reply is missing, which is honestly `indeterminate`; anything earlier is a
 * `failed` attempt we ourselves aborted.
 */
export function deadlineOutcome(stage: Pick<KindleSendStage, 'reachedEnd'>): KindleTerminalOutcome {
  return stage.reachedEnd
    ? { status: 'indeterminate', failureCode: null }
    : { status: 'failed', failureCode: 'attempt_timeout' };
}
