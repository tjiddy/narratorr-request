import { and, count, desc, eq, gte, lt, ne } from 'drizzle-orm';
import type { Readable } from 'node:stream';
import type { Db } from '../../db/client.js';
import { kindleSends, users } from '../../db/schema.js';
import type { IEbookStreamClient, NarratorrEbookStream } from './narratorr-stream-client.js';
import type { KindleSenderResolution, KindleSenderTransport } from './notifications/kindle-sender.js';
import {
  CountingEpubStream,
  EPUB_MEDIA_TYPE,
  KINDLE_SEND_SUBJECT,
  KINDLE_SEND_TEXT,
  classifySendRejection,
  deadlineOutcome,
  sendMailAccepted,
  webStreamToReadable,
  type KindleTerminalOutcome,
  type KindleTransport,
  type KindleTransportFactory,
} from './kindle-send.transport.js';
import {
  KINDLE_SEND_ATTEMPT_DEADLINE_MS,
  KINDLE_SEND_AUDIT_RETENTION_MS,
  KINDLE_SEND_DAILY_ACCEPTED,
  KINDLE_SEND_DAILY_WINDOW_MS,
  KINDLE_SEND_LEASE_MS,
  KINDLE_SEND_REPLAY_WINDOW_MS,
  admitSizeBytes,
  isActiveKindleSendCollision,
  sendBudgetMs,
} from './kindle-send.policy.js';
import type { V1CompanionEbook } from '../../shared/schemas/v1/companion-ebook.js';
import type {
  EbookSendOutcome,
  EbookSendResult,
  KindleSendAttemptStatus,
  KindleSendTerminalStatus,
} from '../../shared/schemas/ebooks.js';
import { KeyedUserLock, MinuteStartCounter, OutcomeSlot } from './kindle-send.gate.js';
import { epubFilename } from '../util/epub-filename.js';
import { ApiError } from '../util/errors.js';

/** The post-admission infrastructure failure (AC42). Never carries a typed SMTP claim. */
function postAdmissionFailure(): ApiError {
  return new ApiError(500, 'INTERNAL', 'The Send-to-Kindle attempt could not be finalized.');
}

// ---- Seams ------------------------------------------------------------------

/** Server logs about a send are keyed on the user's `publicId` and the book id — never an address. */
export interface KindleSendLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface KindleSendDeps {
  db: Db;
  /** The swappable HOLDER, never a captured inner client. */
  narratorr: IEbookStreamClient;
  /** The cached, generation-scoped companion accessor — one cache shared with list enrichment. */
  companions: { get(bookId: string): Promise<V1CompanionEbook | null> };
  /** The ONE atomic settings seam: selection ↔ transport config from a single row read. */
  settings: { getKindleSendSettings(): Promise<{ sender: KindleSenderResolution }> };
  transport: KindleTransportFactory;
  logger: KindleSendLogger;
  /** Clock seam — the single time source for both the in-memory deque and the audit columns. */
  now?: () => number;
  /** Test seam for the send budget; production uses {@link KINDLE_SEND_ATTEMPT_DEADLINE_MS}. */
  attemptDeadlineMs?: number;
}

/** The caller, as the route already has them. The recipient is NEVER taken from the request. */
export interface KindleSendUser {
  id: number;
  publicId: string;
}

/** Everything the preflight resolved, once every precondition passed. */
interface Preflight {
  recipient: string;
  sender: KindleSenderTransport;
  sizeBytes: number;
}

// ---- The service ------------------------------------------------------------

/**
 * `POST /api/ebooks/:bookId/send-to-kindle` (issue #148) — stream narratorr's companion EPUB into
 * an email to the caller's OWN Kindle address, with race-safe admission and an honest outcome.
 *
 * THE AUDIT TABLE IS THE ADMISSION MECHANISM, not a log beside one. Inside a per-user critical
 * section: expire this user's stale leases → resolve replay → count starts and accepted sends →
 * insert the `started` reservation → send → finalize exactly one terminal status on that row. Only
 * a request that has OBSERVED its own durable reservation may send, which is what makes the
 * partial unique index meaningful and stops a `sent` ever existing without an audit row.
 *
 * WHAT THE CRITICAL SECTION BUYS is max-concurrency-1 per user, NOT a duration. There are exactly
 * two uncancellable awaits — the post-transform-`end` SMTP window (a non-pooled `SMTPTransport`
 * builds its connection as a local, and `close()` is cleanup rather than cancellation) and every
 * database call — and for both, abandoning the await would not stop the work, only lose track of
 * it. So the section has no absolute wall-clock bound: a pathological relay or a wedged database
 * can hold ONE user's section until the process restarts. The blast radius is that one user, and
 * the operator's own configured relay is the only party positioned to cause it.
 *
 * TOPOLOGY PRECONDITION, stated rather than assumed: the keyed mutex and the per-minute deque are
 * PER-PROCESS. The per-minute cap, replay suppression, the daily quota and max-concurrency-1 hold
 * only while ONE live application replica owns a given user's traffic — stricter than the README's
 * sticky-session guidance, because the session cookie is a stateless per-login token, so one user
 * on a phone and a laptop holds two different cookie values that ordinary affinity would route to
 * two replicas. What survives regardless of topology is durable: at most one active reservation
 * per `(user, book)`, no send without an observed reservation, and the honesty of every recorded
 * terminal status. See README's single-instance note.
 */
export class KindleSendService {
  private readonly locks = new KeyedUserLock();
  private readonly starts = new MinuteStartCounter();
  private readonly now: () => number;
  private readonly attemptDeadlineMs: number;

  constructor(private readonly deps: KindleSendDeps) {
    this.now = deps.now ?? Date.now;
    this.attemptDeadlineMs = deps.attemptDeadlineMs ?? KINDLE_SEND_ATTEMPT_DEADLINE_MS;
  }

  /** Users with a live lock entry. An observability seam for "the map does not grow unboundedly". */
  get trackedUsers(): number {
    return this.locks.size;
  }

  /**
   * Sweep EVERY user's over-lease `started` rows to `indeterminate` once, at boot. Safe by
   * construction where the per-user admission sweep would not be: nothing is in flight at boot, so
   * no row can be swept out from under a live owner. Awaited before the server accepts traffic.
   */
  async sweepExpiredLeasesAtBoot(): Promise<void> {
    await this.sweepLeases(this.now());
  }

  /**
   * Attempt one send. ALWAYS resolves to a typed outcome for an admitted attempt; it rejects only
   * for the two enumerated infrastructure failures (pre-reservation, and a failed finalization),
   * which the route lets through to the central handler as `500 INTERNAL`.
   */
  async send(
    user: KindleSendUser,
    bookId: string,
    opts: { title?: string | undefined } = {},
  ): Promise<EbookSendResult> {
    try {
      // Preconditions are decided BEFORE the critical section and before a single EPUB byte is
      // fetched. They write nothing and consume no budget, so serializing them would buy nothing
      // and would queue one user's refusals behind another book's live SMTP transaction.
      const pre = await this.preflight(user, bookId);
      if ('outcome' in pre) return { outcome: pre.outcome };
      return await this.locks.run(user.id, () => this.admit(user, bookId, pre, opts));
    } catch (err: unknown) {
      // The classification here is EXACT, not a guess: every post-reservation failure is either
      // absorbed into a terminal outcome or raised as the post-admission `ApiError`, so a
      // non-`ApiError` escaping this method is necessarily a PRE-RESERVATION operational failure —
      // the user read, the settings snapshot, the lease sweep, the replay lookup, the quota counts,
      // or a non-collision reservation insert error. The log carries the safe context only; the
      // error object itself is deliberately never logged from this service.
      if (!(err instanceof ApiError)) {
        this.deps.logger.error(
          this.ctx(user, bookId),
          'kindle-send failed before the reservation was durable — no attempt was recorded',
        );
      }
      throw err;
    }
  }

  // ---- Preconditions --------------------------------------------------------

  /**
   * The precondition ladder, each rung short-circuiting to its own outcome. The boundary is the RAW
   * EPUB STREAM, not "any upstream call": the companion METADATA lookup is explicitly permitted to
   * perform its JSON round-trip on a cold cache, because determining `sizeBytes` and companion
   * presence is impossible without it. What must show zero calls on every refusal path is
   * `openCompanionEpub`.
   *
   * A storage/config failure here PROPAGATES (the pre-reservation infrastructure exception): no
   * audit row is written and the in-memory minute counter is untouched, because the insert was
   * never issued.
   */
  private async preflight(
    user: KindleSendUser,
    bookId: string,
  ): Promise<Preflight | { outcome: EbookSendOutcome }> {
    // (a) The recipient is read EXCLUSIVELY from the caller's own stored address. There is no
    // recipient input of any kind, so this endpoint can never be used as a mail relay.
    const row = await this.deps.db.query.users.findFirst({
      where: eq(users.id, user.id),
      columns: { kindleEmail: true },
    });
    const recipient = row?.kindleEmail ?? null;
    if (!recipient) return { outcome: 'no_kindle_address' };

    // (b) A send proceeds ONLY at sender status `ok`. `kindleDeliveryAvailable === false` is an
    // OUTCOME, not a 403: the feature is on and the operator config is the problem.
    const { sender } = await this.deps.settings.getKindleSendSettings();
    if (!sender || 'failure' in sender) return { outcome: 'no_sender' };

    // (c) A well-formed id narratorr has never heard of lands here — `unavailable`, not a 404, so
    // the route never becomes an existence oracle.
    const companion = await this.deps.companions.get(bookId);
    if (!companion) return { outcome: 'unavailable' };

    // (d) Size preflight, decided from the ADVERTISED value with zero EPUB bytes fetched.
    const admissibility = admitSizeBytes(companion.sizeBytes);
    if (admissibility !== 'ok') return { outcome: admissibility };

    return { recipient, sender, sizeBytes: companion.sizeBytes };
  }

  // ---- Admission ------------------------------------------------------------

  /** One instant for the whole section, so all four rolling windows share one `now`. */
  private async admit(
    user: KindleSendUser,
    bookId: string,
    pre: Preflight,
    opts: { title?: string | undefined },
  ): Promise<EbookSendResult> {
    const now = this.now();

    // 1. Lease expiry, for the ADMITTING USER ONLY. Never other users' rows: a section can outlive
    // its lease (the SMTP window is uncancellable), so a global sweep here could converge a row out
    // from under a live owner. That user's own next admission is queued behind their held mutex, so
    // it cannot run either — which is exactly what makes the scoping safe.
    await this.sweepLeases(now, user.id);
    // Opportunistic retention, keyed on `finalized_at` over TERMINAL rows only. Awaited like every
    // other database call; what is best-effort is its FAILURE, which is swallowed.
    await this.pruneRetention(now, user, bookId);

    // 2. Replay — for EVERY terminal status, `indeterminate` included (an indeterminate attempt is
    // never auto-retried and suppresses re-sends for the window). No new send, no new row, no
    // minute-counter increment.
    const replayed = await this.findReplay(user.id, bookId, now);
    if (replayed) return { outcome: replayed };

    // 3. Counts.
    if (!this.starts.available(user.id, now)) return { outcome: 'rate_limited' };
    if ((await this.dailyUsage(user.id, now)) >= KINDLE_SEND_DAILY_ACCEPTED) {
      return { outcome: 'quota_exhausted' };
    }

    // 4. Reserve. The minute slot is spent from the moment the insert is ATTEMPTED — an active
    // collision and an operational insert failure both reached it, so neither is refunded.
    this.starts.record(user.id, now);
    let reservation: { id: number; startedAtMs: number };
    try {
      reservation = await this.reserve(user.id, bookId, now);
    } catch (err: unknown) {
      if (isActiveKindleSendCollision(err)) return { outcome: 'rate_limited' };
      throw err;
    }

    // 5. Send → finalize exactly one terminal status on that row.
    return this.deliver(user, bookId, pre, opts, reservation);
  }

  /**
   * Mark over-lease `started` rows `indeterminate` / `lease_expired` so they stop occupying the
   * unique index and the quota count. Scoped to one user during admission; global only at boot.
   *
   * ONE comparator for all four windows: a record aged EXACTLY the window length is INSIDE it, so a
   * row is live iff `started_at >= now - LEASE` and the sweep predicate is the strict complement.
   */
  private async sweepLeases(nowMs: number, userId?: number): Promise<void> {
    const expired = lt(kindleSends.startedAt, new Date(nowMs - KINDLE_SEND_LEASE_MS));
    await this.deps.db
      .update(kindleSends)
      .set({ status: 'indeterminate', failureCode: 'lease_expired', finalizedAt: new Date(nowMs) })
      .where(
        userId === undefined
          ? and(eq(kindleSends.status, 'started'), expired)
          : and(eq(kindleSends.userId, userId), eq(kindleSends.status, 'started'), expired),
      );
  }

  /**
   * Prune audit history. The predicate is keyed on `finalized_at` over TERMINAL rows and NEVER on
   * `started_at` — that is load-bearing, not tidiness: a legitimate owner may stay `started`
   * indefinitely while an uncancellable await is pending, and this delete runs GLOBALLY, so a
   * `started_at`-keyed prune run by a DIFFERENT user would destroy that live owner's reservation
   * and the audit record for a possibly-accepted send would simply be gone. The coherence CHECK
   * (`(status = 'started') = (finalized_at IS NULL)`) is what makes the comparison total.
   */
  private async pruneRetention(nowMs: number, user: KindleSendUser, bookId: string): Promise<void> {
    try {
      await this.deps.db
        .delete(kindleSends)
        .where(
          and(
            ne(kindleSends.status, 'started'),
            lt(kindleSends.finalizedAt, new Date(nowMs - KINDLE_SEND_AUDIT_RETENTION_MS)),
          ),
        );
    } catch {
      // Never fails a send. No error object is logged — this service emits safe context only.
      this.deps.logger.warn(this.ctx(user, bookId), 'kindle-send audit retention prune failed — ignored');
    }
  }

  /** The most recent terminal attempt for this `(user, book)` inside the inclusive replay window. */
  private async findReplay(
    userId: number,
    bookId: string,
    nowMs: number,
  ): Promise<KindleSendTerminalStatus | null> {
    const row = await this.deps.db.query.kindleSends.findFirst({
      where: and(
        eq(kindleSends.userId, userId),
        eq(kindleSends.bookId, bookId),
        ne(kindleSends.status, 'started'),
        gte(kindleSends.finalizedAt, new Date(nowMs - KINDLE_SEND_REPLAY_WINDOW_MS)),
      ),
      orderBy: desc(kindleSends.finalizedAt),
      columns: { status: true },
    });
    return row && row.status !== 'started' ? row.status : null;
  }

  /**
   * Rolling daily usage, defined on ACCEPTANCE time rather than start time: a send that starts
   * outside the window and is accepted inside it must occupy a slot, and keying on `started_at`
   * would let an 11th acceptance through inside a real rolling 24 hours. Non-expired `started`
   * reservations are counted too (by `started_at`, since they have no `finalized_at` yet), which is
   * what stops a crash-leaked row from letting the cap be exceeded — the lease bounds the overcount.
   */
  private async dailyUsage(userId: number, nowMs: number): Promise<number> {
    const accepted = await this.deps.db
      .select({ n: count() })
      .from(kindleSends)
      .where(
        and(
          eq(kindleSends.userId, userId),
          eq(kindleSends.status, 'sent'),
          gte(kindleSends.finalizedAt, new Date(nowMs - KINDLE_SEND_DAILY_WINDOW_MS)),
        ),
      );
    const active = await this.deps.db
      .select({ n: count() })
      .from(kindleSends)
      .where(
        and(
          eq(kindleSends.userId, userId),
          eq(kindleSends.status, 'started'),
          gte(kindleSends.startedAt, new Date(nowMs - KINDLE_SEND_LEASE_MS)),
        ),
      );
    return (accepted[0]?.n ?? 0) + (active[0]?.n ?? 0);
  }

  /** Insert the reservation and OBSERVE it — the row this request is allowed to send against. */
  private async reserve(
    userId: number,
    bookId: string,
    nowMs: number,
  ): Promise<{ id: number; startedAtMs: number }> {
    const [row] = await this.deps.db
      .insert(kindleSends)
      .values({
        userId,
        bookId,
        status: 'started',
        byteCount: null,
        failureCode: null,
        startedAt: new Date(nowMs),
        finalizedAt: null,
      })
      .returning({ id: kindleSends.id, startedAt: kindleSends.startedAt });
    if (!row) throw new Error('kindle_sends reservation insert returned no row');
    return { id: row.id, startedAtMs: row.startedAt.getTime() };
  }

  // ---- Send & finalize ------------------------------------------------------

  private async deliver(
    user: KindleSendUser,
    bookId: string,
    pre: Preflight,
    opts: { title?: string | undefined },
    reservation: { id: number; startedAtMs: number },
  ): Promise<EbookSendResult> {
    const budgetMs = sendBudgetMs({
      nowMs: this.now(),
      reservationStartedAtMs: reservation.startedAtMs,
      attemptDeadlineMs: this.attemptDeadlineMs,
    });
    this.deps.logger.info({ ...this.ctx(user, bookId), budgetMs }, 'kindle-send attempt admitted');

    // No usable send window: no upstream connection is opened AT ALL. Honest, and no new state.
    if (budgetMs <= 0) {
      return this.finalize(user, bookId, reservation.id, { status: 'failed', failureCode: 'attempt_timeout' }, null);
    }

    const slot = new OutcomeSlot();
    const controller = new AbortController();
    // One mutable holder rather than four `let`s: every field is written inside the nested attempt
    // and read from the deadline timer and the teardown, so a plain local's narrowing would be
    // meaningless here anyway.
    const live: {
      upstream: Readable | null;
      counter: CountingEpubStream | null;
      transport: KindleTransport | null;
      upstreamErrored: boolean;
    } = { upstream: null, counter: null, transport: null, upstreamErrored: false };

    // Armed no earlier than the open, cleared once an outcome is selected — it is deliberately NOT
    // running during the admission queries or during finalization, both of which are awaited.
    const timer = setTimeout(() => {
      slot.claim(deadlineOutcome({ reachedEnd: live.counter?.reachedEnd ?? false }));
    }, budgetMs);

    const attempt = async (): Promise<void> => {
      let stream: NarratorrEbookStream;
      try {
        stream = await this.deps.narratorr.openCompanionEpub(bookId, { signal: controller.signal });
      } catch {
        // The open rejects AFTER the reservation is durable and BEFORE any transport exists, so no
        // `sendMail` promise is ever created. It is a normal terminal outcome, never a bare 500.
        slot.claim({ status: 'failed', failureCode: 'upstream_unavailable' });
        return;
      }
      const upstream = webStreamToReadable(stream.body);
      const counting = new CountingEpubStream(pre.sizeBytes);
      // A no-op error listener so tearing the attachment down can never surface as an UNCAUGHT
      // 'error' — nodemailer attaches its own handler while it is reading, but the teardown below
      // can also fire between its listeners being removed and the stream being destroyed.
      counting.on('error', () => {});
      live.upstream = upstream;
      live.counter = counting;
      // `pipe` does not forward errors, so a mid-body upstream failure is wired through
      // explicitly: erroring the transform is what aborts DATA and makes the receiving server
      // discard the partial, rather than letting a truncated EPUB end cleanly.
      upstream.on('error', (err: Error) => {
        live.upstreamErrored = true;
        counting.destroy(err);
      });
      upstream.pipe(counting);

      const transport = this.deps.transport(pre.sender.config);
      live.transport = transport;
      const sending = transport.sendMail({
        // The single canonical From — the selected notifier's own, verbatim. Never a second copy.
        from: pre.sender.config.from,
        // ALWAYS the caller's stored address. The request body cannot influence this.
        to: pre.recipient,
        subject: KINDLE_SEND_SUBJECT,
        text: KINDLE_SEND_TEXT,
        attachments: [
          {
            // The ONLY place the caller's `title` is used, and only for their own send.
            filename: epubFilename({ title: opts.title, bookId }),
            content: counting,
            contentType: EPUB_MEDIA_TYPE,
          },
        ],
      });
      try {
        const info = await sending;
        slot.claim(
          sendMailAccepted(info, pre.recipient)
            ? { status: 'sent', failureCode: null }
            : { status: 'failed', failureCode: 'smtp_rejected' },
        );
      } catch (err: unknown) {
        slot.claim(
          classifySendRejection(err, {
            reachedEnd: counting.reachedEnd,
            abortReason: counting.abortReason,
            upstreamErrored: live.upstreamErrored,
          }),
        );
      }
    };

    const running = attempt().catch(() => {
      // Nothing above is expected to throw; if anything ever does, the attempt is still terminal.
      slot.claim({ status: 'failed', failureCode: 'smtp_error' });
    });

    await slot.settled;
    // Only the winner tears down — single assignment is what makes this run exactly once.
    clearTimeout(timer);
    controller.abort();
    // Destroyed WITH an error, deliberately: a bare `destroy()` closes the stream without emitting
    // `error`, and nodemailer would then sit waiting on an attachment that never ends — the
    // deadline would select a row but never actually abort the transaction. Erroring it is what
    // makes DATA incomplete so the receiving server discards the partial. On an attempt that
    // already reached `end` both streams are auto-destroyed, so these calls are no-ops.
    const teardown = new Error('Send-to-Kindle attempt concluded');
    live.upstream?.destroy(teardown);
    live.counter?.destroy(teardown);
    live.transport?.close();
    // The section is NOT released until the SMTP attempt actually settles. Abandoning the await
    // would not stop the transaction, only lose track of it — which is what manufactures orphan
    // reservations. A late settlement cannot change the already-selected outcome.
    await running;

    const terminal = slot.value ?? { status: 'failed' as const, failureCode: 'smtp_error' as const };
    return this.finalize(user, bookId, reservation.id, terminal, live.counter?.bytes ?? null);
  }

  /**
   * The CHECKED terminal write, and its own post-admission contract.
   *
   * `UPDATE … WHERE id = ? AND status = 'started' RETURNING id`, awaited (this whole sequence
   * branches on observed results, so it cannot be detached, and an elapsed send deadline must never
   * truncate it). Zero rows or a rejection gets exactly ONE retry; repeating a conditional update
   * cannot conjure a row, so the disposition then depends on what is actually there. The ONE
   * universal invariant across all four re-read branches is that the spent minute slot remains.
   */
  private async finalize(
    user: KindleSendUser,
    bookId: string,
    rowId: number,
    terminal: KindleTerminalOutcome,
    byteCount: number | null,
  ): Promise<EbookSendResult> {
    const write = (): Promise<Array<{ id: number }>> =>
      this.deps.db
        .update(kindleSends)
        .set({
          status: terminal.status,
          failureCode: terminal.failureCode,
          byteCount,
          finalizedAt: new Date(this.now()),
        })
        .where(and(eq(kindleSends.id, rowId), eq(kindleSends.status, 'started')))
        .returning({ id: kindleSends.id });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        if ((await write()).length > 0) return { outcome: terminal.status };
      } catch {
        this.deps.logger.warn(
          { ...this.ctx(user, bookId), attempt },
          'kindle-send finalization write failed',
        );
      }
    }

    let row: { status: KindleSendAttemptStatus } | undefined;
    try {
      row = await this.deps.db.query.kindleSends.findFirst({
        where: eq(kindleSends.id, rowId),
        columns: { status: true },
      });
    } catch {
      // Durable state is genuinely UNKNOWN — claim nothing about the row.
      this.deps.logger.error(
        this.ctx(user, bookId),
        'kindle-send finalization re-read failed — durable attempt state is unknown',
      );
      throw postAdmissionFailure();
    }
    if (!row) {
      // Nothing to sweep and no later convergence is possible: the audit record is simply gone.
      this.deps.logger.error(
        this.ctx(user, bookId),
        'kindle-send reservation row is absent after the SMTP attempt — no audit record exists',
      );
      throw postAdmissionFailure();
    }
    if (row.status !== 'started') {
      // The audit row is the source of truth, so an earlier or concurrent finalization simply wins.
      return { outcome: row.status };
    }
    this.deps.logger.error(
      this.ctx(user, bookId),
      'kindle-send reservation is still started after a failed finalization — orphaned until the next sweep',
    );
    throw postAdmissionFailure();
  }

  /** The ONLY log context this service ever emits: the user's publicId and the book id. */
  private ctx(user: KindleSendUser, bookId: string): { user: string; book: string } {
    return { user: user.publicId, book: bookId };
  }
}
