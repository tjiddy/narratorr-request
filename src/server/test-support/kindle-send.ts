import type { Readable } from 'node:stream';
import { eq } from 'drizzle-orm';
import { createTestDb, insertUser } from './db.js';
import { kindleSends, type KindleSendRow } from '../../db/schema.js';
import type { Db } from '../../db/client.js';
import type { EmailRuntimeConfig } from '../services/notifications/index.js';
import type { KindleSenderResolution } from '../services/notifications/kindle-sender.js';
import type { IEbookStreamClient, NarratorrEbookStream } from '../services/narratorr-stream-client.js';
import { KindleSendService, type KindleSendLogger } from '../services/kindle-send.service.js';
import type {
  KindleMailMessage,
  KindleSendInfo,
  KindleTransportFactory,
} from '../services/kindle-send.transport.js';
import type { V1CompanionEbook } from '../../shared/schemas/v1/companion-ebook.js';

/**
 * Read an attachment stream to completion, PROPAGATING its error.
 *
 * Draining is what makes this fake behave like a transport rather than a stub: a real SMTP
 * transaction consumes every attachment byte, which is what lets the counting transform reach
 * `flush()` (and therefore its integrity check) and reach `end` (the stage discriminator the
 * rejection taxonomy asks about). A fake that never read the stream would report every send as a
 * mid-stream abort.
 */
async function drain(stream: Readable | undefined): Promise<void> {
  if (!stream) return;
  await new Promise<void>((resolve, reject) => {
    stream.on('data', () => {});
    stream.on('end', () => resolve());
    stream.on('error', (err: Error) => reject(err));
    // A destroyed-without-error attachment must not leave this pending forever — a real transport
    // would see a premature close and fail the transaction, not hang.
    stream.on('close', () => reject(new Error('attachment stream closed before it ended')));
  });
}

/**
 * A recording Kindle transport factory for tests that do NOT need a real socket (route surface,
 * admission races, redaction). Streaming truncation and DATA-abort semantics genuinely require a
 * real SMTP server — those live in the stream test file against `smtp-server`.
 */
export class FakeKindleTransports {
  /** Every message handed to `sendMail`, in order. */
  readonly messages: KindleMailMessage[] = [];
  /** Every config the factory was asked to build a transport for, in order. */
  readonly configs: EmailRuntimeConfig[] = [];
  /** Counted `close()` calls — the teardown receipt. */
  closed = 0;
  /** How many bytes each drained attachment carried, in order. */
  readonly drainedBytes: number[] = [];
  /**
   * What a drained send resolves (or rejects) with. Defaults to accepting the recipient. Override
   * per test to drive the AC39 predicate and the AC40 rejection taxonomy.
   */
  reply: (message: KindleMailMessage) => Promise<KindleSendInfo> = (message) =>
    Promise.resolve({ accepted: [message.to], rejected: [] });

  readonly factory: KindleTransportFactory = (config) => {
    this.configs.push(config);
    return {
      sendMail: async (message) => {
        this.messages.push(message);
        let bytes = 0;
        const content = message.attachments[0]?.content;
        content?.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
        });
        try {
          await drain(content);
        } finally {
          this.drainedBytes.push(bytes);
        }
        return this.reply(message);
      },
      close: () => {
        this.closed += 1;
      },
    };
  };
}

/** A usable email-notifier runtime config — the shape the sender resolver hands the send path. */
export function emailRuntimeConfig(over: Partial<EmailRuntimeConfig> = {}): EmailRuntimeConfig {
  return {
    host: 'smtp.example.com',
    port: 587,
    secure: false,
    user: null,
    pass: null,
    from: 'library@example.com',
    to: 'admin@example.com',
    ...over,
  };
}

/**
 * The raw-EPUB half of a fake narratorr connection, tuned for SEND tests: a byte producer with
 * injectable header-phase and mid-body failures, and a hook between chunks so a test can trickle a
 * body past a deadline. (The download proxy's fake lives in `route-harness.ts`; keeping these
 * separate avoids an import cycle and lets each grow the knobs its own path needs.)
 */
export class FakeEpubStreamClient implements IEbookStreamClient {
  /** Every publicId opened, in order — must stay EMPTY on every refusal path. */
  readonly opened: string[] = [];
  /** The `opts.signal` of each open, so a test can observe the deadline's abort wiring. */
  readonly signals: Array<AbortSignal | undefined> = [];
  /** The bytes the returned stream yields. */
  bytes: Uint8Array = new Uint8Array([1, 2, 3, 4]);
  /** Split {@link bytes} across this many chunks (default: one). */
  chunks = 1;
  /** Advertised `Content-Length`; `undefined` means "the real byte length", `null` means absent. */
  contentLength: number | null | undefined = undefined;
  /** Reject `openCompanionEpub()` itself — the header-phase failure. */
  openError: unknown = null;
  /** Reject AFTER the first chunk has been handed over — the mid-body upstream failure. */
  midStreamError: unknown = null;
  /** Awaited before the open resolves — parks the attempt mid-header-phase. */
  beforeOpen: (() => Promise<void>) | null = null;
  /** Awaited before each chunk — the trickle seam for deadline tests. */
  beforeChunk: (() => Promise<void>) | null = null;

  async openCompanionEpub(publicId: string, opts: { signal?: AbortSignal } = {}): Promise<NarratorrEbookStream> {
    this.signals.push(opts.signal);
    if (this.beforeOpen) await this.beforeOpen();
    this.opened.push(publicId);
    if (this.openError) throw this.openError;
    const { bytes, chunks, midStreamError, beforeChunk } = this;
    const size = Math.max(1, Math.ceil(bytes.byteLength / Math.max(1, chunks)));
    let offset = 0;
    let served = 0;
    return {
      contentType: 'application/epub+zip',
      contentLength: this.contentLength === undefined ? bytes.byteLength : this.contentLength,
      body: new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (beforeChunk) await beforeChunk();
          if (served > 0 && midStreamError) throw midStreamError;
          if (offset >= bytes.byteLength) {
            controller.close();
            return;
          }
          controller.enqueue(bytes.subarray(offset, offset + size));
          offset += size;
          served += 1;
        },
      }),
    };
  }
}

/** The companion metadata seam. Counted SEPARATELY from the stream seam — a cold-cache JSON
 *  round-trip is explicitly permitted on every path, while the stream seam must stay untouched. */
export class StubCompanionAccessor {
  readonly calls: string[] = [];
  value: V1CompanionEbook | null = { format: 'epub', sizeBytes: 4 };
  error: unknown = null;

  async get(bookId: string): Promise<V1CompanionEbook | null> {
    this.calls.push(bookId);
    if (this.error) throw this.error;
    return this.value;
  }
}

/** The atomic Kindle settings snapshot seam. */
export class StubKindleSettings {
  calls = 0;
  sender: KindleSenderResolution = { mailbox: 'library@example.com', config: emailRuntimeConfig() };
  error: unknown = null;

  async getKindleSendSettings(): Promise<{ sender: KindleSenderResolution }> {
    this.calls += 1;
    if (this.error) throw this.error;
    return { sender: this.sender };
  }
}

/** A logger that keeps every line, so redaction can be asserted over the WHOLE emitted surface. */
export class RecordingLogger implements KindleSendLogger {
  readonly lines: Array<{ level: 'info' | 'warn' | 'error'; obj: object; msg: string | undefined }> = [];

  info(obj: object, msg?: string): void {
    this.lines.push({ level: 'info', obj, msg });
  }
  warn(obj: object, msg?: string): void {
    this.lines.push({ level: 'warn', obj, msg });
  }
  error(obj: object, msg?: string): void {
    this.lines.push({ level: 'error', obj, msg });
  }
  /** Everything ever logged, flattened into one scannable string. */
  get text(): string {
    return JSON.stringify(this.lines);
  }
  at(level: 'info' | 'warn' | 'error'): Array<{ obj: object; msg: string | undefined }> {
    return this.lines.filter((l) => l.level === level);
  }
}

export interface KindleSendHarness {
  db: Db;
  svc: KindleSendService;
  user: { id: number; publicId: string };
  stream: FakeEpubStreamClient;
  companions: StubCompanionAccessor;
  settings: StubKindleSettings;
  transports: FakeKindleTransports;
  logger: RecordingLogger;
  /** The injected clock's current value. */
  now(): number;
  setNow(ms: number): void;
  advance(ms: number): void;
  /** Every audit row, oldest id first. */
  rows(): Promise<KindleSendRow[]>;
  rowsFor(bookId: string): Promise<KindleSendRow[]>;
  /** Seed a raw audit row directly — the "a previous process left this behind" fixture. */
  seedRow(row: {
    userId?: number;
    bookId: string;
    status: KindleSendRow['status'];
    startedAtMs: number;
    finalizedAtMs?: number | null;
    failureCode?: KindleSendRow['failureCode'];
  }): Promise<number>;
  /** A second user on the same DB — the scoping fixture for the per-user lease sweep. */
  addUser(kindleEmail?: string | null): Promise<{ id: number; publicId: string }>;
}

export interface KindleSendHarnessOpts {
  /** The injected clock's starting value. Deliberately non-zero so `now - WINDOW` stays positive. */
  now?: number;
  attemptDeadlineMs?: number;
  kindleEmail?: string | null;
  /** Share an already-built DB (the two-service, one-database topology fixture). */
  db?: Db;
  user?: { id: number; publicId: string };
}

/** The default clock origin — well past every window, so cutoff arithmetic never goes negative. */
export const HARNESS_EPOCH = 1_800_000_000_000;

/**
 * A `KindleSendService` wired to a REAL in-memory libSQL database (the audit table IS the
 * admission mechanism, so stubbing it would test nothing) and narrow fakes for everything else.
 */
export async function buildKindleSendHarness(opts: KindleSendHarnessOpts = {}): Promise<KindleSendHarness> {
  const db = opts.db ?? (await createTestDb());
  const user =
    opts.user ??
    (await insertUser(db, { kindleEmail: opts.kindleEmail === undefined ? 'reader@kindle.com' : opts.kindleEmail }));
  const stream = new FakeEpubStreamClient();
  const companions = new StubCompanionAccessor();
  const settings = new StubKindleSettings();
  const transports = new FakeKindleTransports();
  const logger = new RecordingLogger();
  let now = opts.now ?? HARNESS_EPOCH;

  const svc = new KindleSendService({
    db,
    narratorr: stream,
    companions,
    settings,
    transport: transports.factory,
    logger,
    now: () => now,
    ...(opts.attemptDeadlineMs !== undefined && { attemptDeadlineMs: opts.attemptDeadlineMs }),
  });

  return {
    db,
    svc,
    user: { id: user.id, publicId: user.publicId },
    stream,
    companions,
    settings,
    transports,
    logger,
    now: () => now,
    setNow: (ms) => {
      now = ms;
    },
    advance: (ms) => {
      now += ms;
    },
    rows: () => db.select().from(kindleSends),
    rowsFor: (bookId) => db.select().from(kindleSends).where(eq(kindleSends.bookId, bookId)),
    seedRow: async (row) => {
      const [inserted] = await db
        .insert(kindleSends)
        .values({
          userId: row.userId ?? user.id,
          bookId: row.bookId,
          status: row.status,
          byteCount: null,
          failureCode: row.failureCode ?? null,
          startedAt: new Date(row.startedAtMs),
          finalizedAt: row.finalizedAtMs === undefined || row.finalizedAtMs === null ? null : new Date(row.finalizedAtMs),
        })
        .returning({ id: kindleSends.id });
      if (!inserted) throw new Error('failed to seed a kindle_sends row');
      return inserted.id;
    },
    addUser: async (kindleEmail = 'other@kindle.com') => {
      const other = await insertUser(db, { kindleEmail });
      return { id: other.id, publicId: other.publicId };
    },
  };
}
