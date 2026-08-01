import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { StatusPoller } from './status-poller.js';
import { RequestService, BOOK_VANISHED_REASON } from './request.service.js';
import { NarratorrError, type IBookStatusClient } from './narratorr-client.js';
import { UserService } from './user.service.js';
import type { Notifier, NotificationPayload } from './notifications/index.js';
import { createTestDb, insertUser } from '../test-support/db.js';
import { requests, users } from '../../db/schema.js';
import type { Db } from '../../db/client.js';
import type { FastifyBaseLogger } from 'fastify';
import type { V1Book } from '../../shared/schemas/v1/books.js';
import type { V1System } from '../../shared/schemas/v1/system.js';
import type { BookStatus } from '../../shared/schemas/book.js';

const noopLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  trace() {},
  fatal() {},
  child() {
    return noopLogger;
  },
  level: 'silent',
} as unknown as FastifyBaseLogger;

class PollClient implements IBookStatusClient {
  status: BookStatus = 'downloading';
  error: NarratorrError | null = null;
  throwOnAdd: NarratorrError | null = null;
  async searchMetadata() {
    return [];
  }
  async addBook(_asin: string): Promise<V1Book> {
    if (this.throwOnAdd) throw this.throwOnAdd;
    return { id: 'bk_1', title: 't', authors: [], narrators: [], status: this.status };
  }
  async getBook(id: string): Promise<V1Book> {
    if (this.error) throw this.error;
    return { id, title: 't', authors: [], narrators: [], status: this.status };
  }
  async getSystem(): Promise<V1System> {
    return { version: 'v1.0.0' };
  }
}

let db: Db;
let client: PollClient;
let svc: RequestService;
let poller: StatusPoller;

async function seedAcquiring(asin: string, bookId = 'bk_1') {
  const user = await insertUser(db);
  const [row] = await db
    .insert(requests)
    .values({
      publicId: `rq_${asin}`,
      userId: user.id,
      asin,
      title: 't',
      status: 'acquiring',
      narratorrBookId: bookId,
    })
    .returning();
  return row!;
}

/** Seed a request stranded `approved` with no book yet (process died mid-handoff). */
async function seedStranded(asin: string) {
  const user = await insertUser(db);
  const [row] = await db
    .insert(requests)
    .values({ publicId: `rq_${asin}`, userId: user.id, asin, title: 't', status: 'approved' })
    .returning();
  return row!;
}

/**
 * Production-shaped notify deps wired into a RequestService the poller drives: a live-notifier
 * accessor + the real UserService, plus a deferred the notify spy settles. Emission is
 * fire-and-forget (resolve the requester via getById, then dispatch), so tests await the
 * microtask-chained dispatch directly rather than a (fake-timer-unreliable) setTimeout flush.
 */
function notifyHarness() {
  let settle!: (p: NotificationPayload) => void;
  const dispatched = new Promise<NotificationPayload>((resolve) => {
    settle = resolve;
  });
  const notify = vi.fn(async (p: NotificationPayload) => {
    settle(p);
  });
  const holder = { current: { notify } as unknown as Notifier };
  const notifyingSvc = new RequestService(
    db,
    client,
    { defaultQuota: { mode: 'limited', limit: 10 }, windowDays: 30, autoApproveRoles: ['admin'] },
    { getNotifier: () => holder.current, users: new UserService(db) },
  );
  return { notify, notifyingSvc, dispatched };
}

beforeEach(async () => {
  db = await createTestDb();
  client = new PollClient();
  svc = new RequestService(db, client, { defaultQuota: { mode: 'limited', limit: 10 }, windowDays: 30, autoApproveRoles: ['admin'] });
  poller = new StatusPoller({ requests: svc, client, logger: noopLogger, jitterMs: 0 });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('StatusPoller.pollOnce', () => {
  it('drives an acquiring request to available once the book is imported', async () => {
    await seedAcquiring('A1');
    client.status = 'imported';
    const summary = await poller.pollOnce();
    expect(summary).toMatchObject({ checked: 1, transitioned: 1, upstreamErrors: 0 });
    const [row] = await db.select().from(requests).where(eq(requests.asin, 'A1'));
    expect(row?.status).toBe('available');
  });

  it('leaves a still-downloading request as acquiring (no spurious transition)', async () => {
    await seedAcquiring('A1');
    client.status = 'downloading';
    const summary = await poller.pollOnce();
    expect(summary.transitioned).toBe(0);
    const [row] = await db.select().from(requests).where(eq(requests.asin, 'A1'));
    expect(row?.status).toBe('acquiring');
  });

  it('marks a request failed with a friendly reason when its book 404s upstream', async () => {
    await seedAcquiring('A1');
    client.error = new NarratorrError(404, 'NOT_FOUND', 'gone');
    const summary = await poller.pollOnce();
    expect(summary.transitioned).toBe(1);
    const [row] = await db.select().from(requests).where(eq(requests.asin, 'A1'));
    expect(row?.status).toBe('failed');
    expect(row?.failureReason).toBe('This book is no longer available upstream.');
  });

  it("drives an acquiring request to failed ('No source found upstream.') when the book is missing", async () => {
    await seedAcquiring('A1');
    client.status = 'missing'; // mapBookStatus collapses missing → failed (request.service.ts:360-370)
    const summary = await poller.pollOnce();
    expect(summary).toMatchObject({ checked: 1, transitioned: 1, upstreamErrors: 0 });
    const [row] = await db.select().from(requests).where(eq(requests.asin, 'A1'));
    expect(row?.status).toBe('failed');
    // bookStatusFailureReason('missing') (request.service.ts:416-425), driven through pollOnce.
    expect(row?.failureReason).toBe('No source found upstream.');
  });

  it("drives an acquiring request to failed ('Download failed upstream.') when the book status is failed", async () => {
    await seedAcquiring('A1');
    client.status = 'failed'; // mapBookStatus collapses failed → failed (request.service.ts:360-370)
    const summary = await poller.pollOnce();
    expect(summary).toMatchObject({ checked: 1, transitioned: 1, upstreamErrors: 0 });
    const [row] = await db.select().from(requests).where(eq(requests.asin, 'A1'));
    expect(row?.status).toBe('failed');
    // bookStatusFailureReason('failed') (request.service.ts:416-425), driven through pollOnce.
    expect(row?.failureReason).toBe('Download failed upstream.');
  });

  it('recovers a stranded approved request (no book yet) via idempotent handoff', async () => {
    const user = await insertUser(db);
    await db
      .insert(requests)
      .values({ publicId: 'rq_stranded', userId: user.id, asin: 'A9', title: 't', status: 'approved' });
    client.status = 'downloading';
    const summary = await poller.pollOnce();
    expect(summary).toMatchObject({ transitioned: 1, upstreamErrors: 0 });
    const [row] = await db.select().from(requests).where(eq(requests.asin, 'A9'));
    expect(row?.status).toBe('acquiring');
    expect(row?.narratorrBookId).toBe('bk_1');
  });

  it('counts a transient upstream error without changing status', async () => {
    await seedAcquiring('A1');
    client.error = new NarratorrError(503, 'UPSTREAM', 'flaky');
    const summary = await poller.pollOnce();
    expect(summary).toMatchObject({ checked: 1, transitioned: 0, upstreamErrors: 1 });
    const [row] = await db.select().from(requests).where(eq(requests.asin, 'A1'));
    expect(row?.status).toBe('acquiring');
  });
});

// The control loop is driven through the *real* Cron created by start(): croner
// schedules via setTimeout and computes next-run off Date, both of which
// vi.useFakeTimers() controls, so advancing the clock fires exactly one tick per
// interval (verified: one fire per `intervalSeconds` advance). We assert observable
// cadence via a spy on the public pollOnce() — a *skipped* tick never calls it — so
// the private skipTicks/failureStreak fields are never read directly. Each poller here
// uses intervalSeconds: 1 (one tick per 1000ms advance) and jitterMs: 0 (no sleep
// inside pollOnce, so a clock-advance resolves a tick fully).
describe('StatusPoller control loop (backoff state machine, fixed-clock)', () => {
  function makePoller() {
    return new StatusPoller({ requests: svc, client, logger: noopLogger, jitterMs: 0, intervalSeconds: 1 });
  }
  const oneTick = () => vi.advanceTimersByTimeAsync(1000);

  it('AC#1a backs off (skips the next tick) when pollOnce reports upstream errors with no transitions', async () => {
    await seedAcquiring('A1');
    client.error = new NarratorrError(503, 'UPSTREAM', 'flaky'); // getBook throws → upstreamErrors, not a reject
    vi.useFakeTimers({ now: 0 });
    const p = makePoller();
    const spy = vi.spyOn(p, 'pollOnce');
    p.start();

    await oneTick(); // tick 1: { checked:1, transitioned:0, upstreamErrors:1 } → backoff, skipTicks=1
    expect(spy).toHaveBeenCalledTimes(1);
    await oneTick(); // tick 2: skipTicks>0 → returns early, no poll
    expect(spy).toHaveBeenCalledTimes(1);
    await oneTick(); // tick 3: polls again
    expect(spy).toHaveBeenCalledTimes(2);

    p.stop();
  });

  it('AC#1b backs off when pollOnce itself rejects (catch branch)', async () => {
    // The only uncaught seam in pollOnce is its two DB reads; mockRejectedValueOnce on
    // the public method drives the catch path without depending on which read throws.
    vi.useFakeTimers({ now: 0 });
    const p = makePoller();
    const spy = vi.spyOn(p, 'pollOnce').mockRejectedValueOnce(new Error('boom'));
    p.start();

    await oneTick(); // tick 1: pollOnce rejects → tick catch → backoff, skipTicks=1
    expect(spy).toHaveBeenCalledTimes(1);
    await oneTick(); // tick 2: skipped
    expect(spy).toHaveBeenCalledTimes(1);
    await oneTick(); // tick 3: polls (real impl now; no rows → harmless)
    expect(spy).toHaveBeenCalledTimes(2);

    p.stop();
  });

  it('AC#1c backs off when a REAL DB read inside pollOnce rejects (catch branch, pollOnce unmocked)', async () => {
    // Unlike AC#1b (which mocks pollOnce wholesale), this drives the genuine catch seam: the
    // DB read at status-poller.ts:110 (`findAcquiring`) rejects, so the real pollOnce throws and
    // tick()'s catch backs off. Same observable cadence as AC#1b → same skipTicks=1 gating.
    await seedAcquiring('A1');
    vi.useFakeTimers({ now: 0 });
    const p = makePoller();
    const spy = vi.spyOn(p, 'pollOnce'); // count calls only — NOT mocked
    vi.spyOn(svc, 'findAcquiring').mockRejectedValueOnce(new Error('db read boom'));
    p.start();

    await oneTick(); // tick 1: real pollOnce → findAcquiring rejects → tick catch → backoff, skipTicks=1
    expect(spy).toHaveBeenCalledTimes(1);
    await oneTick(); // tick 2: skipTicks>0 → skipped, no poll
    expect(spy).toHaveBeenCalledTimes(1);
    await oneTick(); // tick 3: polls again (findAcquiring restored → real read, succeeds)
    expect(spy).toHaveBeenCalledTimes(2);

    p.stop();
  });

  it('AC#1 resets the failure streak after a successful tick (next failure skips only one tick again)', async () => {
    await seedAcquiring('A1');
    vi.useFakeTimers({ now: 0 });
    const p = makePoller();
    const spy = vi.spyOn(p, 'pollOnce');
    p.start();

    client.error = new NarratorrError(503, 'UPSTREAM', 'flaky');
    await oneTick(); // tick 1: fail → streak 1, skipTicks 1   (poll #1)
    await oneTick(); // tick 2: skipped
    client.error = null;
    await oneTick(); // tick 3: success → streak reset to 0      (poll #2)
    client.error = new NarratorrError(503, 'UPSTREAM', 'flaky');
    await oneTick(); // tick 4: fail → streak 1 again, skipTicks 1 (poll #3)
    await oneTick(); // tick 5: skipped (only one — proves reset, not streak 2 → 2 skips)
    await oneTick(); // tick 6: polls again                       (poll #4)

    // Had the streak NOT reset, tick 4 would be streak 2 (skipTicks 2): ticks 5 AND 6
    // skipped, leaving poll count at 3 here. 4 proves the reset.
    expect(spy).toHaveBeenCalledTimes(4);

    p.stop();
  });

  it('AC#1 grows the skip exponentially and caps at 8 under sustained failure', async () => {
    await seedAcquiring('A1');
    client.error = new NarratorrError(503, 'UPSTREAM', 'flaky'); // every poll fails
    vi.useFakeTimers({ now: 0 });
    const p = makePoller();
    const spy = vi.spyOn(p, 'pollOnce');
    p.start();

    // Record the 1-based tick index at each tick where a poll actually happened.
    const pollTicks: number[] = [];
    let prev = 0;
    for (let t = 1; t <= 29; t += 1) {
      await oneTick();
      if (spy.mock.calls.length > prev) {
        pollTicks.push(t);
        prev = spy.mock.calls.length;
      }
    }

    // skipTicks = min(2^(streak-1), 8): streak 1→1, 2→2, 3→4, 4→8, 5→8(capped), 6→8.
    // Polls therefore land at ticks 1,3,6,11,20,29 — the final two gaps both 9 (8 skips)
    // prove the cap holds at 8 instead of growing to 16/32.
    expect(pollTicks).toEqual([1, 3, 6, 11, 20, 29]);

    p.stop();
  });

  it('does NOT back off when the only failure is a stranded handoff with zero acquiring rows (checked === 0 gate)', async () => {
    await seedStranded('A9'); // no acquiring rows at all
    client.throwOnAdd = new NarratorrError(503, 'UPSTREAM', 'flaky'); // handoff retry fails transiently
    vi.useFakeTimers({ now: 0 });
    const p = makePoller();
    const spy = vi.spyOn(p, 'pollOnce');
    p.start();

    // pollOnce → { checked:0, transitioned:0, upstreamErrors:1 }: the backoff gate
    // requires checked > 0, so the streak resets and the next tick is NOT skipped.
    await oneTick();
    expect(spy).toHaveBeenCalledTimes(1);
    await oneTick();
    expect(spy).toHaveBeenCalledTimes(2); // polled every tick — no backoff

    p.stop();
  });
});

describe('StatusPoller cron lifecycle (fixed-clock)', () => {
  it('start() is idempotent and stop() halts ticking', async () => {
    vi.useFakeTimers({ now: 0 });
    const p = new StatusPoller({ requests: svc, client, logger: noopLogger, jitterMs: 0, intervalSeconds: 1 });
    const spy = vi.spyOn(p, 'pollOnce');

    p.start();
    p.start(); // `if (this.job) return` guard — must not schedule a second job
    await vi.advanceTimersByTimeAsync(1000);
    expect(spy).toHaveBeenCalledTimes(1); // single job → one tick, not two

    p.stop();
    await vi.advanceTimersByTimeAsync(3000);
    expect(spy).toHaveBeenCalledTimes(1); // stopped → no further ticks
  });
});

describe('StatusPoller.pollOnce reconciliation edges', () => {
  // #213: retry semantics branch on status (404 vs everything else), never on `upstreamCode`, so
  // the new status-0 `TIMEOUT` must count and retry exactly like the 5xx case it sits beside.
  it.each([
    ['5xx UPSTREAM', () => new NarratorrError(503, 'UPSTREAM', 'flaky')],
    ['status-0 TIMEOUT', () => new NarratorrError(0, 'TIMEOUT', 'timed out')],
  ])('AC#2 counts a transient stranded-handoff failure (%s), leaves the row approved, and still checks the batch', async (_label, err) => {
    await seedStranded('A9'); // approved, no book
    await seedAcquiring('A1'); // co-existing in-flight row
    client.throwOnAdd = err(); // handoff rethrows (transient)
    client.status = 'downloading'; // acquiring row stays acquiring when checked

    const summary = await poller.pollOnce();

    // Stranded handoff failed (counted, not transitioned); the acquiring row was still checked.
    expect(summary).toMatchObject({ checked: 1, transitioned: 0, upstreamErrors: 1 });
    const [stranded] = await db.select().from(requests).where(eq(requests.asin, 'A9'));
    expect(stranded?.status).toBe('approved'); // unchanged — poller retries next pass
    expect(stranded?.narratorrBookId).toBeNull();
    const [acquiring] = await db.select().from(requests).where(eq(requests.asin, 'A1'));
    expect(acquiring?.status).toBe('acquiring');
  });

  it('AC#3 sleeps the EXACT computed jitter delay (Math.floor(random * jitterMs)) before polling', async () => {
    await seedAcquiring('A1');
    client.status = 'downloading';
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const jittered = new StatusPoller({ requests: svc, client, logger: noopLogger, jitterMs: 100 });

    const pending = jittered.pollOnce(); // suspends on sleep(floor(0.5 * 100) = 50ms)
    await vi.runAllTimersAsync(); // resolves the sleep timer (and interleaved DB microtasks)
    const summary = await pending;

    // The jitter sleep (status-poller.ts:114) is the only setTimeout pollOnce schedules, and its
    // delay is Math.floor(Math.random() * jitterMs) = floor(0.5 * 100) = 50ms exactly — asserting
    // the precise value (not just "was called") pins the formula, catching an off-by-one or a
    // dropped Math.floor that toHaveBeenCalled() would miss.
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 50);
    expect(summary).toMatchObject({ checked: 1 });
  });
});

// The poller 404 path is part of issue #60's exactly-once notification contract — the
// reconciliation tests above only assert the DB edge (status/reason) on a request service
// with no notify deps. These wire the production-shaped notify deps (live-notifier accessor
// + UserService) into the request service the poller drives, and assert the request.failed
// dispatch flows through pollOnce's 404 branch — once, and not again on a repeated poll.
describe('StatusPoller 404 path — request.failed emission (#60)', () => {
  it('dispatches request.failed once (BOOK_VANISHED_REASON) when the book 404s, and not again on a repeated poll', async () => {
    const { notify, notifyingSvc, dispatched } = notifyHarness();
    const p = new StatusPoller({ requests: notifyingSvc, client, logger: noopLogger, jitterMs: 0 });
    const seeded = await seedAcquiring('A1');
    client.error = new NarratorrError(404, 'NOT_FOUND', 'gone');

    const summary = await p.pollOnce();
    expect(summary).toMatchObject({ checked: 1, transitioned: 1 });

    const payload = await dispatched; // resolves when the (fire-and-forget) emission dispatches
    expect(notify).toHaveBeenCalledTimes(1);
    expect(payload).toMatchObject({
      event: 'request.failed',
      request: { publicId: seeded.publicId, asin: 'A1' },
      requester: { username: 'tester' },
      reason: BOOK_VANISHED_REASON,
    });

    // The row is now `failed`; findAcquiring won't return it, so a second poll observes
    // nothing to transition (checked: 0) — markFailed/emitFailed are never reached, so there
    // is no second dispatch to wait for. A microtask flush confirms the count stays at one.
    const again = await p.pollOnce();
    expect(again).toMatchObject({ checked: 0, transitioned: 0 });
    await Promise.resolve();
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

// The poller's stranded-`approved` recovery path is the one request.failed entry point that
// was previously untested (the #60 suite only covered the acquiring-row 404 branch). A TERMINAL
// handoff error here both emits request.failed once AND must be counted as a transition (issue
// #68 AC4) — recoverHandoff resolves on terminal failure so the poller doesn't log it as an
// upstream error and wrongly trip backoff. (The transient half — counted as an upstream error,
// row left `approved` for retry — is pinned by 'AC#2 counts a transient stranded-handoff failure'.)
// The requester availability-email sweep (#121) is the third pollOnce pass and the SOLE sender of
// the "your audiobook is ready" email. These assert the poller DRIVES the sweep, and that the
// sweep's fire-and-forget isolation matches the other passes: a per-row send fault never unwinds
// the tick, while a sweep-level DB READ fault propagates to the tick's guard (backoff), exactly
// like findAcquiring rejecting (AC#1c above).
describe('StatusPoller availability-email sweep (#121)', () => {
  function sweepSvc(send: (args: unknown) => Promise<'delivered' | 'skipped-no-config'>) {
    return new RequestService(
      db,
      client,
      { defaultQuota: { mode: 'limited', limit: 10 }, windowDays: 30, autoApproveRoles: ['admin'] },
      {
        getNotifier: () => ({ notify: async () => {} } as unknown as Notifier),
        users: new UserService(db),
        requesterEmail: { send: send as never },
      },
    );
  }

  /** Seed an `available` row owed an email: opted-in requester with a contact, null marker. */
  async function seedOwedAvailable(asin: string) {
    const user = await insertUser(db);
    await db.update(users).set({ email: `${asin}@example.com`, notifyOn: ['available'] }).where(eq(users.id, user.id));
    const [row] = await db
      .insert(requests)
      .values({ publicId: `rq_${asin}`, userId: user.id, asin, title: 't', status: 'available', narratorrBookId: 'bk_1' })
      .returning();
    return row!;
  }

  it('pollOnce drives the sweep — an owed available row is delivered and its marker settled', async () => {
    const send = vi.fn(async (): Promise<'delivered'> => 'delivered');
    const svc = sweepSvc(send);
    const p = new StatusPoller({ requests: svc, client, logger: noopLogger, jitterMs: 0 });
    const row = await seedOwedAvailable('A1');

    // No acquiring rows — checked stays 0 — but the sweep still runs and delivers.
    const summary = await p.pollOnce();
    expect(summary).toMatchObject({ checked: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    const [fresh] = await db.select().from(requests).where(eq(requests.id, row.id));
    expect(fresh?.availableNotifiedAt).not.toBeNull();
  });

  it('a per-row send rejection in the sweep never unwinds the tick (pollOnce still resolves; marker left null)', async () => {
    const send = vi.fn(async (): Promise<'delivered'> => {
      throw new Error('smtp down');
    });
    const svc = sweepSvc(send);
    const p = new StatusPoller({ requests: svc, client, logger: noopLogger, jitterMs: 0 });
    const row = await seedOwedAvailable('A1');

    await expect(p.pollOnce()).resolves.toMatchObject({ checked: 0, upstreamErrors: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    const [fresh] = await db.select().from(requests).where(eq(requests.id, row.id));
    expect(fresh?.availableNotifiedAt).toBeNull(); // replayable next tick
  });

  it('a sweep-level DB read fault propagates to the tick guard (pollOnce rejects → backoff)', async () => {
    const send = vi.fn(async (): Promise<'delivered'> => 'delivered');
    const svc = sweepSvc(send);
    vi.spyOn(svc, 'findAvailableAwaitingNotify').mockRejectedValueOnce(new Error('db read boom'));
    const p = new StatusPoller({ requests: svc, client, logger: noopLogger, jitterMs: 0 });
    await seedOwedAvailable('A1');

    await expect(p.pollOnce()).rejects.toThrow('db read boom');
    expect(send).not.toHaveBeenCalled();
  });
});

describe('StatusPoller stranded-handoff terminal emission (#68)', () => {
  it('emits request.failed once on a terminal stranded handoff, counts it as a transition (not an upstream error), and does not re-emit on the next poll', async () => {
    const { notify, notifyingSvc, dispatched } = notifyHarness();
    const p = new StatusPoller({ requests: notifyingSvc, client, logger: noopLogger, jitterMs: 0 });
    const seeded = await seedStranded('A9');
    // 422 asin_not_resolved is terminal per isTerminalHandoffError → handoff transitions the row
    // to `failed`, emits once, and rethrows; recoverHandoff swallows the rethrow as a transition.
    client.throwOnAdd = new NarratorrError(422, 'asin_not_resolved', 'unresolvable');

    const summary = await p.pollOnce();
    // No acquiring rows; the stranded terminal failure is counted as a transition, NOT an upstream
    // error (which would wrongly back off even though the terminal transition actually succeeded).
    expect(summary).toMatchObject({ checked: 0, transitioned: 1, upstreamErrors: 0 });

    const payload = await dispatched; // resolves when the fire-and-forget emission dispatches
    expect(notify).toHaveBeenCalledTimes(1);
    expect(payload).toMatchObject({
      event: 'request.failed',
      request: { publicId: seeded.publicId, asin: 'A9' },
      requester: { username: 'tester' },
      reason: "Couldn't find this book in the catalog.", // friendly handoffFailureReason for asin_not_resolved
    });
    const [row] = await db.select().from(requests).where(eq(requests.asin, 'A9'));
    expect(row?.status).toBe('failed');

    // Second poll: the row is now `failed`, so findApprovedAwaitingHandoff won't return it —
    // nothing transitions and no second request.failed is emitted.
    const again = await p.pollOnce();
    expect(again).toMatchObject({ checked: 0, transitioned: 0, upstreamErrors: 0 });
    await Promise.resolve();
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
