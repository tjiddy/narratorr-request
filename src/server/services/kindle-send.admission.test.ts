import { describe, it, expect, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  buildKindleSendHarness,
  type KindleSendHarness,
} from '../test-support/kindle-send.js';
import { kindleSends } from '../../db/schema.js';
import {
  KINDLE_SEND_AUDIT_RETENTION_MS,
  KINDLE_SEND_DAILY_ACCEPTED,
  KINDLE_SEND_DAILY_WINDOW_MS,
  KINDLE_SEND_LEASE_MS,
  KINDLE_SEND_REPLAY_WINDOW_MS,
  KINDLE_SEND_STARTS_PER_MINUTE,
  KINDLE_SEND_START_WINDOW_MS,
} from './kindle-send.policy.js';

// Race-safe admission (issue #148), driven against a REAL in-memory libSQL database — the audit
// table IS the admission mechanism, so a stubbed DB would prove nothing here. Time is the injected
// clock throughout (never a real wait): every property under test is about WHICH window a record
// falls in, which a wall clock cannot express deterministically.
//
// Per CLAUDE.md, everything is atomic single statements — libSQL `:memory:` breaks across
// `db.transaction()`.

const BOOK = 'bk_one';
const OTHER = 'bk_two';

/** Let every already-scheduled microtask / timer callback run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A deferred whose rejection is pre-handled, so parking one can't trip node's detector. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

/** Seed `n` prior ACCEPTED sends inside the daily window, each for its own book. */
async function seedAccepted(h: KindleSendHarness, n: number, agoMs = 1000): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await h.seedRow({
      bookId: `bk_prior_${i}`,
      status: 'sent',
      startedAtMs: h.now() - agoMs - 1,
      finalizedAtMs: h.now() - agoMs,
    });
  }
}

describe('the critical section — max concurrency 1 per user', () => {
  // THE HEADLINE CASE. The partial unique index does not cover this — different books never
  // collide on it — so the keyed mutex is the only thing standing between N concurrent requests
  // and N acceptances past the cap. Remove the mutex and this goes red.
  it('CROSS-BOOK QUOTA RACE: concurrent sends of DIFFERENT books admit exactly one at the cap', async () => {
    const h = await buildKindleSendHarness();
    await seedAccepted(h, KINDLE_SEND_DAILY_ACCEPTED - 1);

    const results = await Promise.all(
      ['bk_a', 'bk_b', 'bk_c'].map((book) => h.svc.send(h.user, book)),
    );
    const outcomes = results.map((r) => r.outcome).sort();
    expect(outcomes).toEqual(['quota_exhausted', 'quota_exhausted', 'sent']);
    // Exactly one new audit row: the refusals never reserved.
    const rows = await h.rows();
    expect(rows.filter((r) => r.bookId.startsWith('bk_') && !r.bookId.startsWith('bk_prior')).length).toBe(1);
  });

  it('A/B/C LATE ARRIVAL: never more than one attempt inside the section, and the map drains', async () => {
    const h = await buildKindleSendHarness();
    let inside = 0;
    let peak = 0;
    const gateA = deferred<void>();
    // The settings read is the first awaited step INSIDE the section for each attempt… but the
    // preflight runs outside it, so instrument the transport instead: that is unambiguously inside.
    h.transports.reply = async (message) => {
      inside += 1;
      peak = Math.max(peak, inside);
      if (message.attachments[0]?.filename.startsWith('bk_a')) await gateA.promise;
      inside -= 1;
      return { accepted: [message.to], rejected: [] };
    };

    const a = h.svc.send(h.user, 'bk_a');
    await flush();
    const b = h.svc.send(h.user, 'bk_b');
    await flush();
    // C arrives while A is still holding and B is queued — the shape a naive
    // `finally { map.delete(id) }` gets wrong, deleting B's entry and letting C run beside it.
    const c = h.svc.send(h.user, 'bk_c');
    await flush();
    expect(peak).toBe(1);

    gateA.resolve();
    await Promise.all([a, b, c]);
    expect(peak).toBe(1);
    // …and the entry is eventually removed, so the map does not grow unboundedly.
    expect(h.svc.trackedUsers).toBe(0);
  });

  it('SERIALIZATION HAS NO EXCEPTION: a stalled INSERT blocks the same user’s next admission', async () => {
    const h = await buildKindleSendHarness();
    const gate = deferred<void>();
    const realInsert = h.db.insert.bind(h.db);
    // Park the reservation INSERT: a request may only send on a reservation it has OBSERVED, so
    // nothing downstream of it may run — and the successor may not enter admission at all.
    vi.spyOn(h.db, 'insert').mockImplementationOnce(((table: any) => {
      const real = realInsert(table);
      return {
        values: (vals: any) => ({
          returning: (cols: any) => gate.promise.then(() => real.values(vals).returning(cols)),
        }),
      };
    }) as any);

    const a = h.svc.send(h.user, BOOK);
    await flush();
    // Nothing fetched, nothing sent — the request is still waiting on its own reservation, and no
    // orphan row exists for it yet beyond the parked statement.
    expect(h.stream.opened).toEqual([]);
    expect(h.transports.messages).toEqual([]);

    let bSettled = false;
    const b = h.svc.send(h.user, OTHER).then((r) => {
      bSettled = true;
      return r;
    });
    await flush();
    expect(bSettled).toBe(false);
    expect(h.stream.opened).toEqual([]);

    gate.resolve();
    expect((await a).outcome).toBe('sent');
    expect((await b).outcome).toBe('sent');
    vi.restoreAllMocks();
  });

  // The topology precondition, DOCUMENTED rather than silently assumed. This is not asserting a
  // cross-process guarantee — it is pinning that none exists, which is what the README note says.
  it('TOPOLOGY: the deque and the mutex are PER-PROCESS — two services on one DB admit 3 EACH', async () => {
    const one = await buildKindleSendHarness();
    const two = await buildKindleSendHarness({ db: one.db, user: one.user });
    for (let i = 0; i < KINDLE_SEND_STARTS_PER_MINUTE; i += 1) {
      expect((await one.svc.send(one.user, `bk_one_${i}`)).outcome).toBe('sent');
      expect((await two.svc.send(two.user, `bk_two_${i}`)).outcome).toBe('sent');
    }
    // SIX starts inside one minute for ONE user, against a cap of three. This DOCUMENTS the
    // single-replica boundary the README note names; it is not asserting a cross-process
    // guarantee the spec makes, because there isn't one.
    expect((await one.rows()).filter((r) => r.status === 'sent')).toHaveLength(2 * KINDLE_SEND_STARTS_PER_MINUTE);
    // Each replica's own deque is now spent, independently.
    expect((await one.svc.send(one.user, 'bk_one_x')).outcome).toBe('rate_limited');
    expect((await two.svc.send(two.user, 'bk_two_x')).outcome).toBe('rate_limited');
  });
});

describe('the per-minute start cap — a ROLLING window, not a tumbling bucket', () => {
  it('admits three starts and refuses the fourth, then re-admits once the window rolls off', async () => {
    const h = await buildKindleSendHarness();
    for (let i = 0; i < KINDLE_SEND_STARTS_PER_MINUTE; i += 1) {
      expect((await h.svc.send(h.user, `bk_${i}`)).outcome).toBe('sent');
    }
    expect(await h.svc.send(h.user, 'bk_4')).toEqual({ outcome: 'rate_limited' });
    // A refusal fetched no bytes and wrote no row.
    expect(h.stream.opened).toHaveLength(KINDLE_SEND_STARTS_PER_MINUTE);
    expect(await h.rowsFor('bk_4')).toEqual([]);

    h.advance(KINDLE_SEND_START_WINDOW_MS + 1);
    expect((await h.svc.send(h.user, 'bk_4')).outcome).toBe('sent');
  });

  it('EXACT CUTOFF: a start aged exactly the window still occupies a slot; one ms older does not', async () => {
    const h = await buildKindleSendHarness();
    for (let i = 0; i < KINDLE_SEND_STARTS_PER_MINUTE; i += 1) {
      await h.svc.send(h.user, `bk_${i}`);
    }
    h.advance(KINDLE_SEND_START_WINDOW_MS);
    expect(await h.svc.send(h.user, 'bk_at_cutoff')).toEqual({ outcome: 'rate_limited' });
    h.advance(1);
    expect((await h.svc.send(h.user, 'bk_past_cutoff')).outcome).toBe('sent');
  });

  it('ROLLING, NOT BUCKETED: three at 0:59 and three at 1:00 do not both admit', async () => {
    const h = await buildKindleSendHarness();
    h.advance(59_000);
    for (let i = 0; i < KINDLE_SEND_STARTS_PER_MINUTE; i += 1) {
      expect((await h.svc.send(h.user, `bk_a${i}`)).outcome).toBe('sent');
    }
    // A fixed tumbling bucket resets here and would admit three more — 6 in ~1 second.
    h.advance(1_000);
    const second = [];
    for (let i = 0; i < KINDLE_SEND_STARTS_PER_MINUTE; i += 1) {
      second.push((await h.svc.send(h.user, `bk_b${i}`)).outcome);
    }
    expect(second).toEqual(['rate_limited', 'rate_limited', 'rate_limited']);
  });

  // The minute budget is spent at the INSERT ATTEMPT, so everything that refuses earlier must
  // leave all three slots intact. A counter incremented before the preconditions would still pass
  // a "zero DB writes" assertion, which is why this asserts the SLOTS rather than the rows.
  it('no non-reserving refusal spends a minute slot', async () => {
    const h = await buildKindleSendHarness();
    // Every pre-admission refusal, in one sweep.
    h.settings.sender = { failure: 'sender-changed' };
    expect((await h.svc.send(h.user, 'bk_r1')).outcome).toBe('no_sender');
    h.settings.sender = { mailbox: 'library@example.com', config: h.transports.configs[0] ?? (await import('../test-support/kindle-send.js')).emailRuntimeConfig() };
    h.companions.value = null;
    expect((await h.svc.send(h.user, 'bk_r2')).outcome).toBe('unavailable');
    h.companions.value = { format: 'epub', sizeBytes: Number.MAX_SAFE_INTEGER };
    expect((await h.svc.send(h.user, 'bk_r3')).outcome).toBe('too_large');
    h.companions.value = { format: 'epub', sizeBytes: 4 };
    // …plus a replay hit and a daily refusal, the two in-section non-reserving paths.
    await h.seedRow({ bookId: 'bk_replay', status: 'sent', startedAtMs: h.now() - 10, finalizedAtMs: h.now() - 5 });
    expect((await h.svc.send(h.user, 'bk_replay')).outcome).toBe('sent');
    await seedAccepted(h, KINDLE_SEND_DAILY_ACCEPTED);
    expect((await h.svc.send(h.user, 'bk_r4')).outcome).toBe('quota_exhausted');

    // All three slots must still be there. Clear the daily block and prove it by admitting three.
    await h.db.delete(kindleSends).where(eq(kindleSends.status, 'sent'));
    for (let i = 0; i < KINDLE_SEND_STARTS_PER_MINUTE; i += 1) {
      expect((await h.svc.send(h.user, `bk_fresh${i}`)).outcome).toBe('sent');
    }
    expect((await h.svc.send(h.user, 'bk_fresh_x')).outcome).toBe('rate_limited');
  });

  it('a FAILED attempt spends the minute budget but never the daily quota; a SENT spends both', async () => {
    const h = await buildKindleSendHarness();
    // A size mismatch is a `failed` terminal attempt that genuinely reached the insert.
    h.companions.value = { format: 'epub', sizeBytes: 99 };
    h.stream.bytes = new Uint8Array(4);
    expect((await h.svc.send(h.user, 'bk_bad')).outcome).toBe('failed');

    h.companions.value = { format: 'epub', sizeBytes: 4 };
    expect((await h.svc.send(h.user, 'bk_ok1')).outcome).toBe('sent');
    expect((await h.svc.send(h.user, 'bk_ok2')).outcome).toBe('sent');
    // Three starts spent → the fourth is rate limited even though only two were accepted.
    expect((await h.svc.send(h.user, 'bk_ok3')).outcome).toBe('rate_limited');

    // Only the `sent` rows count against the daily quota.
    const rows = await h.rows();
    expect(rows.filter((r) => r.status === 'sent')).toHaveLength(2);
    expect(rows.filter((r) => r.status === 'failed')).toHaveLength(1);
  });
});

describe('the daily quota — defined on ACCEPTANCE time', () => {
  it('counts a send accepted 23h59m ago and ignores one accepted 24h01m ago', async () => {
    const h = await buildKindleSendHarness();
    await seedAccepted(h, KINDLE_SEND_DAILY_ACCEPTED - 1, 23 * 3_600_000 + 59 * 60_000);
    await h.seedRow({
      bookId: 'bk_old',
      status: 'sent',
      startedAtMs: h.now() - KINDLE_SEND_DAILY_WINDOW_MS - 120_000,
      finalizedAtMs: h.now() - KINDLE_SEND_DAILY_WINDOW_MS - 60_000,
    });
    // 9 inside + 1 outside → the 10th slot is free.
    expect((await h.svc.send(h.user, BOOK)).outcome).toBe('sent');
    expect((await h.svc.send(h.user, OTHER)).outcome).toBe('quota_exhausted');
  });

  it('counts a row STARTED 25h ago but ACCEPTED 10 minutes ago — the case started_at gets wrong', async () => {
    const h = await buildKindleSendHarness();
    await seedAccepted(h, KINDLE_SEND_DAILY_ACCEPTED - 1);
    await h.seedRow({
      bookId: 'bk_long',
      status: 'sent',
      startedAtMs: h.now() - 25 * 3_600_000,
      finalizedAtMs: h.now() - 600_000,
    });
    // A `started_at`-keyed implementation would miss this row and let an 11th acceptance through.
    expect(await h.svc.send(h.user, BOOK)).toEqual({ outcome: 'quota_exhausted' });
  });

  it('EXACT CUTOFF: finalized_at exactly 24h ago is COUNTED', async () => {
    const h = await buildKindleSendHarness();
    await seedAccepted(h, KINDLE_SEND_DAILY_ACCEPTED - 1);
    await h.seedRow({
      bookId: 'bk_edge',
      status: 'sent',
      startedAtMs: h.now() - KINDLE_SEND_DAILY_WINDOW_MS - 1000,
      finalizedAtMs: h.now() - KINDLE_SEND_DAILY_WINDOW_MS,
    });
    expect(await h.svc.send(h.user, BOOK)).toEqual({ outcome: 'quota_exhausted' });
    // One millisecond older and the slot is free again.
    await h.db
      .update(kindleSends)
      .set({ finalizedAt: new Date(h.now() - KINDLE_SEND_DAILY_WINDOW_MS - 1) })
      .where(eq(kindleSends.bookId, 'bk_edge'));
    expect((await h.svc.send(h.user, BOOK)).outcome).toBe('sent');
  });

  it('counts NON-EXPIRED started reservations, so a leaked row cannot let the cap be exceeded', async () => {
    const h = await buildKindleSendHarness();
    await seedAccepted(h, KINDLE_SEND_DAILY_ACCEPTED - 1);
    // A live reservation for some other book genuinely occupies a slot.
    await h.seedRow({ bookId: 'bk_leaked', status: 'started', startedAtMs: h.now() - 1000 });
    expect(await h.svc.send(h.user, BOOK)).toEqual({ outcome: 'quota_exhausted' });
  });

  it('only counts the CALLER’s rows — another user’s acceptances are irrelevant', async () => {
    const h = await buildKindleSendHarness();
    const other = await h.addUser();
    for (let i = 0; i < KINDLE_SEND_DAILY_ACCEPTED; i += 1) {
      await h.seedRow({
        userId: other.id,
        bookId: `bk_other_${i}`,
        status: 'sent',
        startedAtMs: h.now() - 2000,
        finalizedAtMs: h.now() - 1000,
      });
    }
    expect((await h.svc.send(h.user, BOOK)).outcome).toBe('sent');
  });
});

describe('replay — the prior outcome, verbatim, with no new send and no new row', () => {
  it.each(['sent', 'failed', 'indeterminate'] as const)(
    'replays a prior %s inside the window, and never auto-retries',
    async (status) => {
      const h = await buildKindleSendHarness();
      await h.seedRow({
        bookId: BOOK,
        status,
        startedAtMs: h.now() - 5000,
        finalizedAtMs: h.now() - 1000,
        ...(status === 'sent' ? {} : { failureCode: 'smtp_error' as const }),
      });
      expect(await h.svc.send(h.user, BOOK)).toEqual({ outcome: status });
      expect(h.stream.opened).toEqual([]);
      expect(h.transports.messages).toEqual([]);
      expect(await h.rowsFor(BOOK)).toHaveLength(1);
    },
  );

  it('EXACT CUTOFF: finalized exactly the window ago is REPLAYED; one ms older admits a fresh send', async () => {
    const h = await buildKindleSendHarness();
    const id = await h.seedRow({
      bookId: BOOK,
      status: 'indeterminate',
      startedAtMs: h.now() - KINDLE_SEND_REPLAY_WINDOW_MS - 1000,
      finalizedAtMs: h.now() - KINDLE_SEND_REPLAY_WINDOW_MS,
      failureCode: 'lease_expired',
    });
    expect(await h.svc.send(h.user, BOOK)).toEqual({ outcome: 'indeterminate' });
    expect(h.stream.opened).toEqual([]);

    await h.db
      .update(kindleSends)
      .set({ finalizedAt: new Date(h.now() - KINDLE_SEND_REPLAY_WINDOW_MS - 1) })
      .where(eq(kindleSends.id, id));
    expect((await h.svc.send(h.user, BOOK)).outcome).toBe('sent');
    expect(h.stream.opened).toEqual([BOOK]);
  });

  it('MILLISECOND STORAGE: 59,999 ms ago replays while 60,800 ms ago does not', async () => {
    // These two cases are indistinguishable under second-resolution columns, which is the point.
    const h = await buildKindleSendHarness();
    const id = await h.seedRow({
      bookId: BOOK,
      status: 'sent',
      startedAtMs: h.now() - 70_000,
      finalizedAtMs: h.now() - 59_999,
    });
    expect(await h.svc.send(h.user, BOOK)).toEqual({ outcome: 'sent' });
    expect(h.stream.opened).toEqual([]);

    await h.db.update(kindleSends).set({ finalizedAt: new Date(h.now() - 60_800) }).where(eq(kindleSends.id, id));
    expect((await h.svc.send(h.user, BOOK)).outcome).toBe('sent');
    expect(h.stream.opened).toEqual([BOOK]);
  });

  it('is scoped to (user, book): another book and another user are unaffected', async () => {
    const h = await buildKindleSendHarness();
    const other = await h.addUser();
    await h.seedRow({ bookId: BOOK, status: 'failed', startedAtMs: h.now() - 10, finalizedAtMs: h.now() - 5, failureCode: 'oversize' });
    expect((await h.svc.send(h.user, OTHER)).outcome).toBe('sent');
    expect((await h.svc.send(other, BOOK)).outcome).toBe('sent');
  });

  it('persists startedAt/finalizedAt in MILLISECONDS from the injected clock', async () => {
    const h = await buildKindleSendHarness({ now: 1_800_000_000_123 });
    await h.svc.send(h.user, BOOK);
    const [row] = await h.rowsFor(BOOK);
    // Sub-second precision survives the round trip — a `timestamp` (second) column would truncate.
    expect(row?.startedAt.getTime()).toBe(1_800_000_000_123);
    expect(row?.finalizedAt?.getTime()).toBe(1_800_000_000_123);
  });
});

describe('the reservation lease', () => {
  it('sweeps a user’s own over-lease row to indeterminate / lease_expired on their next admission', async () => {
    const h = await buildKindleSendHarness();
    await h.seedRow({ bookId: BOOK, status: 'started', startedAtMs: h.now() - KINDLE_SEND_LEASE_MS - 1 });
    // A different book, so the sweep is observable without the replay window interfering.
    expect((await h.svc.send(h.user, OTHER)).outcome).toBe('sent');
    const [swept] = await h.rowsFor(BOOK);
    expect(swept).toMatchObject({ status: 'indeterminate', failureCode: 'lease_expired' });
    expect(swept?.finalizedAt?.getTime()).toBe(h.now());
  });

  it('is SCOPED to the admitting user — another user’s admission leaves the row untouched', async () => {
    const h = await buildKindleSendHarness();
    const other = await h.addUser();
    await h.seedRow({ bookId: BOOK, status: 'started', startedAtMs: h.now() - KINDLE_SEND_LEASE_MS - 1 });
    expect((await h.svc.send(other, OTHER)).outcome).toBe('sent');
    expect((await h.rowsFor(BOOK))[0]?.status).toBe('started');
  });

  it('the BOOT sweep converges it globally, across every user', async () => {
    const h = await buildKindleSendHarness();
    const other = await h.addUser();
    await h.seedRow({ bookId: BOOK, status: 'started', startedAtMs: h.now() - KINDLE_SEND_LEASE_MS - 1 });
    await h.seedRow({ userId: other.id, bookId: OTHER, status: 'started', startedAtMs: h.now() - KINDLE_SEND_LEASE_MS - 1 });
    await h.svc.sweepExpiredLeasesAtBoot();
    for (const row of await h.rows()) {
      expect(row).toMatchObject({ status: 'indeterminate', failureCode: 'lease_expired' });
    }
  });

  it('EXACT CUTOFF: started_at exactly LEASE ago is still LIVE — not swept, and still collides', async () => {
    const h = await buildKindleSendHarness();
    await h.seedRow({ bookId: BOOK, status: 'started', startedAtMs: h.now() - KINDLE_SEND_LEASE_MS });
    await h.svc.sweepExpiredLeasesAtBoot();
    expect((await h.rowsFor(BOOK))[0]?.status).toBe('started');

    // A same-book attempt hits the active-unique collision, and spends a minute slot for it.
    expect(await h.svc.send(h.user, BOOK)).toEqual({ outcome: 'rate_limited' });
    expect((await h.rowsFor(BOOK))[0]?.status).toBe('started');
    // An admission by this very user does not sweep it either — it is not expired.
    expect((await h.svc.send(h.user, OTHER)).outcome).toBe('sent');
    expect((await h.rowsFor(BOOK))[0]?.status).toBe('started');
  });

  it('EXACT CUTOFF: the still-live row counts toward the daily active-reservation total', async () => {
    const h = await buildKindleSendHarness();
    await h.seedRow({ bookId: BOOK, status: 'started', startedAtMs: h.now() - KINDLE_SEND_LEASE_MS });
    await seedAccepted(h, KINDLE_SEND_DAILY_ACCEPTED - 1);
    expect(await h.svc.send(h.user, OTHER)).toEqual({ outcome: 'quota_exhausted' });
  });

  it('ONE MILLISECOND BEYOND: swept, and the quota slot it held is freed for THIS admission', async () => {
    const h = await buildKindleSendHarness();
    await h.seedRow({ bookId: BOOK, status: 'started', startedAtMs: h.now() - KINDLE_SEND_LEASE_MS - 1 });
    await seedAccepted(h, KINDLE_SEND_DAILY_ACCEPTED - 1);
    // The sweep runs BEFORE the counts, so the freed slot is visible to this very admission.
    expect((await h.svc.send(h.user, OTHER)).outcome).toBe('sent');
    expect((await h.rowsFor(BOOK))[0]).toMatchObject({ status: 'indeterminate', failureCode: 'lease_expired' });
  });

  it('ONE MILLISECOND BEYOND: the same book is then REPLAYED as indeterminate for a further window', async () => {
    const h = await buildKindleSendHarness();
    await h.seedRow({ bookId: BOOK, status: 'started', startedAtMs: h.now() - KINDLE_SEND_LEASE_MS - 1 });
    // The sweep finalizes the row with `finalized_at = now`, which lands INSIDE the inclusive
    // replay window — so the same book stays blocked for another minute AFTER the sweep. That is
    // the indeterminate contract working (a crash-orphan may well have reached Amazon), not a bug.
    expect(await h.svc.send(h.user, BOOK)).toEqual({ outcome: 'indeterminate' });
    expect(h.stream.opened).toEqual([]);

    h.advance(KINDLE_SEND_REPLAY_WINDOW_MS + 1);
    expect((await h.svc.send(h.user, BOOK)).outcome).toBe('sent');
  });

  it('convergence is ADMISSION-triggered, not wall-clock: no send, no boot → the row stays started', async () => {
    const h = await buildKindleSendHarness();
    await h.seedRow({ bookId: BOOK, status: 'started', startedAtMs: h.now() });
    h.advance(KINDLE_SEND_LEASE_MS * 5);
    await flush();
    // The honest contract: there is deliberately NO periodic sweeper.
    expect((await h.rowsFor(BOOK))[0]?.status).toBe('started');
    await h.svc.send(h.user, OTHER);
    expect((await h.rowsFor(BOOK))[0]?.status).toBe('indeterminate');
  });
});

describe('the active-reservation unique index', () => {
  it('answers rate_limited on a collision — never a 500 — and spends a minute slot', async () => {
    const h = await buildKindleSendHarness();
    // Only reachable across processes / a restart in practice, since the mutex serializes one
    // process; seeding the row is how a single-process test reaches it.
    await h.seedRow({ bookId: BOOK, status: 'started', startedAtMs: h.now() });
    expect(await h.svc.send(h.user, BOOK)).toEqual({ outcome: 'rate_limited' });

    // The insert was ATTEMPTED, so the slot is spent: only two starts remain in this minute.
    expect((await h.svc.send(h.user, 'bk_x1')).outcome).toBe('sent');
    expect((await h.svc.send(h.user, 'bk_x2')).outcome).toBe('sent');
    expect((await h.svc.send(h.user, 'bk_x3')).outcome).toBe('rate_limited');
  });
});

describe('retention pruning', () => {
  it('removes a TERMINAL row past the retention window and keeps one inside it', async () => {
    const h = await buildKindleSendHarness();
    await h.seedRow({
      bookId: 'bk_ancient',
      status: 'sent',
      startedAtMs: h.now() - KINDLE_SEND_AUDIT_RETENTION_MS - 10_000,
      finalizedAtMs: h.now() - KINDLE_SEND_AUDIT_RETENTION_MS - 1,
    });
    await h.seedRow({
      bookId: 'bk_recent',
      status: 'sent',
      startedAtMs: h.now() - KINDLE_SEND_AUDIT_RETENTION_MS,
      finalizedAtMs: h.now() - KINDLE_SEND_AUDIT_RETENTION_MS + 1,
    });
    await h.svc.send(h.user, BOOK);
    const books = (await h.rows()).map((r) => r.bookId).sort();
    expect(books).toEqual(['bk_recent', BOOK].sort());
  });

  // The load-bearing case. An implementation that prunes globally BY `started_at` passes every
  // other retention test and fails only this one — destroying a live owner's reservation, after
  // which finalization finds the row absent and the audit record for a possibly-accepted send is
  // simply gone.
  it('NEVER deletes a LIVE owner’s started row, however old, and that owner still finalizes', async () => {
    const h = await buildKindleSendHarness();
    const other = await h.addUser();
    const gate = deferred<void>();
    h.transports.reply = async (message) => {
      await gate.promise;
      return { accepted: [message.to], rejected: [] };
    };

    // User A is mid-send; wind the clock far past retention so a started_at-keyed prune would
    // consider A's reservation eligible.
    const a = h.svc.send(h.user, BOOK);
    await flush();
    expect((await h.rowsFor(BOOK))[0]?.status).toBe('started');
    h.advance(KINDLE_SEND_AUDIT_RETENTION_MS + 60_000);

    // User B's admission runs the opportunistic (global) prune.
    h.transports.reply = (message) => Promise.resolve({ accepted: [message.to], rejected: [] });
    await h.svc.send(other, OTHER);
    expect((await h.rowsFor(BOOK))[0]?.status).toBe('started');

    gate.resolve();
    // A's own finalization still finds its row — no absent-row 500, no lost audit record.
    expect(await a).toEqual({ outcome: 'sent' });
    expect((await h.rowsFor(BOOK))[0]?.status).toBe('sent');
  });

  it('a pruning FAILURE never fails the send', async () => {
    const h = await buildKindleSendHarness();
    const realDelete = h.db.delete.bind(h.db);
    let thrown = false;
    h.db.delete = ((table: Parameters<typeof realDelete>[0]) => {
      if (!thrown) {
        thrown = true;
        throw new Error('disk is on fire');
      }
      return realDelete(table);
    }) as typeof h.db.delete;
    expect((await h.svc.send(h.user, BOOK)).outcome).toBe('sent');
    expect(h.logger.at('warn').some((l) => l.msg?.includes('retention prune failed'))).toBe(true);
  });
});

describe('pre-reservation operational failures — the infrastructure exception', () => {
  // These PROPAGATE rather than being wrapped: the central error handler owns the envelope, and a
  // typed 200 outcome here would claim an admitted attempt with no audit row, breaking
  // audit-as-admission. The route test asserts the resulting `500 INTERNAL` envelope.
  it('the SETTINGS snapshot read', async () => {
    const h = await buildKindleSendHarness();
    h.settings.error = new Error('settings unreadable');
    await expect(h.svc.send(h.user, BOOK)).rejects.toThrow('settings unreadable');
    expect(await h.rows()).toEqual([]);
    h.settings.error = null;
    // The minute counter is untouched because the insert was never ISSUED — proven by spending
    // all three fresh slots afterwards rather than by reading a private field.
    for (let i = 0; i < KINDLE_SEND_STARTS_PER_MINUTE; i += 1) {
      expect((await h.svc.send(h.user, `bk_${i}`)).outcome).toBe('sent');
    }
  });

  it('the USER read', async () => {
    const h = await buildKindleSendHarness();
    vi.spyOn(h.db.query.users, 'findFirst').mockImplementationOnce((() =>
      Promise.reject(new Error('users table unreadable'))) as any);
    await expect(h.svc.send(h.user, BOOK)).rejects.toThrow('users table unreadable');
    expect(await h.rows()).toEqual([]);
    vi.restoreAllMocks();
  });

  it.each([
    ['the LEASE SWEEP', 'update' as const],
    ['the QUOTA COUNT', 'select' as const],
  ])('%s', async (_label, method) => {
    const h = await buildKindleSendHarness();
    const spy = vi.spyOn(h.db, method).mockImplementationOnce((() => {
      throw new Error(`${method} failed`);
    }) as any);
    await expect(h.svc.send(h.user, BOOK)).rejects.toThrow(`${method} failed`);
    expect(spy).toHaveBeenCalled();
    expect(await h.rows()).toEqual([]);
    vi.restoreAllMocks();
    // The minute slot survives — all three are still available.
    for (let i = 0; i < KINDLE_SEND_STARTS_PER_MINUTE; i += 1) {
      expect((await h.svc.send(h.user, `bk_${i}`)).outcome).toBe('sent');
    }
  });

  it('the REPLAY LOOKUP — a rejected query is a 500, no row, no stream, no counter change', async () => {
    const h = await buildKindleSendHarness();
    vi.spyOn(h.db.query.kindleSends, 'findFirst').mockImplementationOnce((() =>
      Promise.reject(new Error('replay lookup failed'))) as any);
    await expect(h.svc.send(h.user, BOOK)).rejects.toThrow('replay lookup failed');
    expect(await h.rows()).toEqual([]);
    expect(h.stream.opened).toEqual([]);
    vi.restoreAllMocks();
    for (let i = 0; i < KINDLE_SEND_STARTS_PER_MINUTE; i += 1) {
      expect((await h.svc.send(h.user, `bk_${i}`)).outcome).toBe('sent');
    }
  });

  it('logs the failure with the SAFE context only — publicId and book id, nothing else', async () => {
    const h = await buildKindleSendHarness();
    h.settings.error = new Error('settings unreadable: smtp password hunter2');
    await expect(h.svc.send(h.user, BOOK)).rejects.toBeTruthy();
    // The service itself never logs an error object, so an injected message cannot ride out.
    expect(h.logger.text).not.toContain('hunter2');
  });

  it('a NON-collision insert error is a 500 with no row — but the minute slot IS spent', async () => {
    const h = await buildKindleSendHarness();
    const realInsert = h.db.insert.bind(h.db);
    vi.spyOn(h.db, 'insert').mockImplementationOnce(((table: any) => {
      void realInsert;
      void table;
      return {
        values: () => ({
          returning: () =>
            Promise.reject(
              // A CHECK breach is genuine corruption, not "slow down" — the broad
              // SQLITE_CONSTRAINT classifier would have mislabelled this `rate_limited`.
              Object.assign(new Error('Failed query: insert into "kindle_sends"'), {
                cause: new Error('SQLITE_CONSTRAINT: CHECK constraint failed: kindle_sends_status_finalized'),
              }),
            ),
        }),
      };
    }) as any);

    await expect(h.svc.send(h.user, BOOK)).rejects.toThrow(/Failed query/);
    expect(await h.rows()).toEqual([]);
    vi.restoreAllMocks();
    // The insert was ATTEMPTED, so one slot is gone: only two starts remain in this minute.
    expect((await h.svc.send(h.user, 'bk_a')).outcome).toBe('sent');
    expect((await h.svc.send(h.user, 'bk_b')).outcome).toBe('sent');
    expect((await h.svc.send(h.user, 'bk_c')).outcome).toBe('rate_limited');
  });
});

describe('the send phase — the reservation is observed BEFORE any byte is fetched', () => {
  it('opens no upstream connection until the INSERT has been observed', async () => {
    const h = await buildKindleSendHarness();
    const gate = deferred<void>();
    const realInsert = h.db.insert.bind(h.db);
    vi.spyOn(h.db, 'insert').mockImplementationOnce(((table: any) => {
      const real = realInsert(table);
      return {
        values: (vals: any) => ({
          returning: (cols: any) => gate.promise.then(() => real.values(vals).returning(cols)),
        }),
      };
    }) as any);

    const sending = h.svc.send(h.user, BOOK);
    await flush();
    expect(h.stream.opened).toEqual([]);
    expect(h.transports.messages).toEqual([]);
    gate.resolve();
    expect((await sending).outcome).toBe('sent');
    vi.restoreAllMocks();
  });

  // AC41 row 0. The open rejects AFTER the reservation is durable and BEFORE any transport exists.
  it('a POST-RESERVATION open rejection is 200 failed / upstream_unavailable, never a bare 500', async () => {
    const h = await buildKindleSendHarness();
    h.stream.openError = new Error('narratorr is unreachable');
    expect(await h.svc.send(h.user, BOOK)).toEqual({ outcome: 'failed' });

    const [row] = await h.rowsFor(BOOK);
    expect(row).toMatchObject({ status: 'failed', failureCode: 'upstream_unavailable' });
    // No transport was ever built and no sendMail was issued…
    expect(h.transports.configs).toEqual([]);
    expect(h.transports.messages).toEqual([]);
    // …the minute slot is spent, and the daily quota is untouched (only `sent` spends that).
    h.stream.openError = null;
    expect((await h.svc.send(h.user, 'bk_x1')).outcome).toBe('sent');
    expect((await h.svc.send(h.user, 'bk_x2')).outcome).toBe('sent');
    expect((await h.svc.send(h.user, 'bk_x3')).outcome).toBe('rate_limited');
  });

  it('a mid-body upstream failure is failed / upstream_unavailable and never reports sent', async () => {
    const h = await buildKindleSendHarness();
    h.companions.value = { format: 'epub', sizeBytes: 8 };
    h.stream.bytes = new Uint8Array(8);
    h.stream.chunks = 4;
    h.stream.midStreamError = new Error('upstream socket died');
    expect(await h.svc.send(h.user, BOOK)).toEqual({ outcome: 'failed' });
    expect((await h.rowsFor(BOOK))[0]).toMatchObject({ status: 'failed', failureCode: 'upstream_unavailable' });
  });

  it('persists byteCount once the stream establishes it — zero, non-zero and a mismatch alike', async () => {
    const zero = await buildKindleSendHarness();
    zero.companions.value = { format: 'epub', sizeBytes: 0 };
    zero.stream.bytes = new Uint8Array(0);
    expect((await zero.svc.send(zero.user, BOOK)).outcome).toBe('sent');
    expect((await zero.rowsFor(BOOK))[0]?.byteCount).toBe(0);

    const some = await buildKindleSendHarness();
    some.companions.value = { format: 'epub', sizeBytes: 7 };
    some.stream.bytes = new Uint8Array(7);
    expect((await some.svc.send(some.user, BOOK)).outcome).toBe('sent');
    expect((await some.rowsFor(BOOK))[0]?.byteCount).toBe(7);

    const short = await buildKindleSendHarness();
    short.companions.value = { format: 'epub', sizeBytes: 99 };
    short.stream.bytes = new Uint8Array(5);
    expect((await short.svc.send(short.user, BOOK)).outcome).toBe('failed');
    const [row] = await short.rowsFor(BOOK);
    // The COUNTED bytes, not the advertised ones — that is what makes the row diagnosable.
    expect(row).toMatchObject({ failureCode: 'size_mismatch', byteCount: 5 });
  });

  it('leaves byteCount NULL when no upstream connection was ever opened', async () => {
    const h = await buildKindleSendHarness();
    // A reservation observed at or past its own lease has no usable send window at all.
    await h.seedRow({ bookId: OTHER, status: 'sent', startedAtMs: h.now(), finalizedAtMs: h.now() });
    const realInsert = h.db.insert.bind(h.db);
    vi.spyOn(h.db, 'insert').mockImplementationOnce(((table: any) => {
      const real = realInsert(table);
      return {
        values: (vals: any) => ({
          returning: async (cols: any) => {
            const rows = await real.values(vals).returning(cols);
            // Durable at T0, observed only after the whole lease elapsed — the gap AC34 declines
            // to bound. The clamp must refuse to open a connection at all.
            h.advance(KINDLE_SEND_LEASE_MS + 1);
            return rows;
          },
        }),
      };
    }) as any);

    expect(await h.svc.send(h.user, BOOK)).toEqual({ outcome: 'failed' });
    expect(h.stream.opened).toEqual([]);
    expect(h.transports.configs).toEqual([]);
    const [row] = await h.rowsFor(BOOK);
    expect(row).toMatchObject({ status: 'failed', failureCode: 'attempt_timeout', byteCount: null });
    vi.restoreAllMocks();
  });

  it('logs the ARMED BUDGET, clamped to the remaining lease rather than the full deadline', async () => {
    const h = await buildKindleSendHarness();
    const realInsert = h.db.insert.bind(h.db);
    vi.spyOn(h.db, 'insert').mockImplementationOnce(((table: any) => {
      const real = realInsert(table);
      return {
        values: (vals: any) => ({
          returning: async (cols: any) => {
            const rows = await real.values(vals).returning(cols);
            h.advance(KINDLE_SEND_LEASE_MS - 30_000);
            return rows;
          },
        }),
      };
    }) as any);
    await h.svc.send(h.user, BOOK);
    vi.restoreAllMocks();
    const admitted = h.logger.at('info').find((l) => l.msg?.includes('admitted'));
    expect(admitted?.obj).toMatchObject({ user: h.user.publicId, book: BOOK, budgetMs: 30_000 });
  });

  it('a client walking away does NOT abort an admitted send — it runs to its terminal status', async () => {
    const h = await buildKindleSendHarness();
    const gate = deferred<void>();
    h.transports.reply = async (message) => {
      await gate.promise;
      return { accepted: [message.to], rejected: [] };
    };
    // `send()` takes no abort signal at all, so a disconnected caller cannot cancel it: the audit
    // row and the user's quota stay truthful.
    const sending = h.svc.send(h.user, BOOK);
    await flush();
    expect((await h.rowsFor(BOOK))[0]?.status).toBe('started');
    gate.resolve();
    expect(await sending).toEqual({ outcome: 'sent' });
    expect((await h.rowsFor(BOOK))[0]?.status).toBe('sent');
    expect(h.transports.messages).toHaveLength(1);
  });
});

describe('finalization failure — the post-admission contract (its own, opposite invariants)', () => {
  /** Fail the terminal UPDATE `times` times, then behave normally. Counts the attempts. */
  function breakFinalization(h: KindleSendHarness, times: number): { updates: () => number } {
    const realUpdate = h.db.update.bind(h.db);
    let updates = 0;
    vi.spyOn(h.db, 'update').mockImplementation(((table: any) => {
      const real = realUpdate(table);
      const realSet = real.set.bind(real);
      real.set = ((vals: any) => {
        const q = realSet(vals);
        const realWhere = q.where.bind(q);
        q.where = ((cond: any) => {
          const w = realWhere(cond);
          // Only the terminal write has `.returning` called on it; the lease sweep does not.
          const realReturning = (w as any).returning?.bind(w);
          if (realReturning) {
            (w as any).returning = (cols: any) => {
              updates += 1;
              return updates <= times
                ? Promise.reject(new Error('finalization write failed'))
                : realReturning(cols);
            };
          }
          return w;
        }) as any;
        return q;
      }) as any;
      return real;
    }) as any);
    return { updates: () => updates };
  }

  it('(a) an independently-finalized row wins the re-read and answers 200 with its DURABLE status', async () => {
    const h = await buildKindleSendHarness();
    const counter = breakFinalization(h, 2);
    // Converge the row from underneath, exactly as another process's lease sweep would.
    h.transports.reply = async (message) => {
      await h.db
        .update(kindleSends)
        .set({ status: 'indeterminate', failureCode: 'lease_expired', finalizedAt: new Date(h.now()) })
        .where(and(eq(kindleSends.bookId, BOOK), eq(kindleSends.status, 'started')));
      return { accepted: [message.to], rejected: [] };
    };
    // The convergence UPDATE above also runs through the spy, so re-arm it around that call.
    vi.restoreAllMocks();
    const counter2 = breakFinalization(h, 2);
    void counter;

    // The write is retried EXACTLY once before the re-read, then the durable status wins.
    expect(await h.svc.send(h.user, BOOK)).toEqual({ outcome: 'indeterminate' });
    expect(counter2.updates()).toBe(2);
    const [row] = await h.rowsFor(BOOK);
    expect(row).toMatchObject({ status: 'indeterminate' });
    vi.restoreAllMocks();
  });

  it('(b) a row still STARTED is a post-admission 500; the row survives and a later sweep converges it', async () => {
    const h = await buildKindleSendHarness();
    const counter = breakFinalization(h, 2);
    await expect(h.svc.send(h.user, BOOK)).rejects.toMatchObject({ statusCode: 500, code: 'INTERNAL' });
    expect(counter.updates()).toBe(2); // one write + exactly ONE retry
    vi.restoreAllMocks();

    // The orphan exists with NO process death — a double-failed finalization is the second producer.
    expect((await h.rowsFor(BOOK))[0]?.status).toBe('started');
    // It converges only on a later admission (or boot), never on a wall clock.
    h.advance(KINDLE_SEND_LEASE_MS + 1);
    await h.svc.sweepExpiredLeasesAtBoot();
    expect((await h.rowsFor(BOOK))[0]).toMatchObject({ status: 'indeterminate', failureCode: 'lease_expired' });
  });

  it('(c) an ABSENT row is a post-admission 500 with an error-level anomaly log and NO row at all', async () => {
    const h = await buildKindleSendHarness();
    const counter = breakFinalization(h, 2);
    h.transports.reply = async (message) => {
      await h.db.delete(kindleSends).where(eq(kindleSends.bookId, BOOK));
      return { accepted: [message.to], rejected: [] };
    };
    await expect(h.svc.send(h.user, BOOK)).rejects.toMatchObject({ statusCode: 500 });
    expect(counter.updates()).toBe(2);
    vi.restoreAllMocks();
    // Nothing to sweep and no later convergence is possible — assert exactly that.
    expect(await h.rowsFor(BOOK)).toEqual([]);
    const anomaly = h.logger.at('error').find((l) => l.msg?.includes('absent'));
    expect(anomaly?.obj).toEqual({ user: h.user.publicId, book: BOOK });
  });

  it('(d) a REJECTING re-read is a post-admission 500 with durable state UNKNOWN — nothing asserted about the row', async () => {
    const h = await buildKindleSendHarness();
    const counter = breakFinalization(h, 2);
    // Only the RE-READ may reject: the replay lookup goes through the same accessor and runs
    // FIRST, and rejecting that would be a pre-reservation failure — a different contract.
    const realFindFirst = h.db.query.kindleSends.findFirst.bind(h.db.query.kindleSends);
    let reads = 0;
    vi.spyOn(h.db.query.kindleSends, 'findFirst').mockImplementation(((cfg: any) => {
      reads += 1;
      return reads === 1 ? realFindFirst(cfg) : Promise.reject(new Error('re-read failed'));
    }) as any);
    await expect(h.svc.send(h.user, BOOK)).rejects.toMatchObject({ statusCode: 500, code: 'INTERNAL' });
    expect(counter.updates()).toBe(2);
    expect(h.logger.at('error').some((l) => l.msg?.includes('unknown'))).toBe(true);
    vi.restoreAllMocks();
    // Deliberately NO assertion about row existence here: the spec says claim nothing.
  });

  it('logs the pre-reservation failure with the SAFE context: publicId and book id, nothing else', async () => {
    const h = await buildKindleSendHarness();
    h.settings.error = new Error('boom');
    await expect(h.svc.send(h.user, BOOK)).rejects.toThrow('boom');
    const line = h.logger.at('error').find((l) => l.msg?.includes('before the reservation was durable'));
    expect(line?.obj).toEqual({ user: h.user.publicId, book: BOOK });
  });

  it('the ONE universal post-admission invariant: the spent minute slot remains, in every branch', async () => {
    // Branch (b) is the cheapest to reach; the slot accounting is identical across all four,
    // because it is taken durably-in-memory before SMTP runs and is never refunded.
    const h = await buildKindleSendHarness();
    const counter = breakFinalization(h, 2);
    await expect(h.svc.send(h.user, BOOK)).rejects.toBeTruthy();
    void counter;
    vi.restoreAllMocks();
    expect((await h.svc.send(h.user, 'bk_a')).outcome).toBe('sent');
    expect((await h.svc.send(h.user, 'bk_b')).outcome).toBe('sent');
    expect((await h.svc.send(h.user, 'bk_c')).outcome).toBe('rate_limited');
  });

  it('an ELAPSED send deadline never truncates finalization — the DB calls are awaited, not raced', async () => {
    const h = await buildKindleSendHarness({ attemptDeadlineMs: 20 });
    h.transports.reply = async (message) => {
      // Settle well past the deadline; the awaited AC42 sequence must still run to completion.
      await new Promise((r) => setTimeout(r, 60));
      return { accepted: [message.to], rejected: [] };
    };
    const result = await h.svc.send(h.user, BOOK);
    expect(['sent', 'indeterminate', 'failed']).toContain(result.outcome);
    // Whatever the deadline selected, a terminal row was written — finalization was not skipped.
    expect((await h.rowsFor(BOOK))[0]?.status).not.toBe('started');
  });
});

describe('orphans — both producers, and the global daily cost', () => {
  it('an orphan consumes a GLOBAL daily slot, and the next admission sweeps it before the counts', async () => {
    const h = await buildKindleSendHarness();
    await seedAccepted(h, KINDLE_SEND_DAILY_ACCEPTED - 1);
    // The non-crash producer: a double-failed finalization leaves the row `started`.
    const realUpdate = h.db.update.bind(h.db);
    vi.spyOn(h.db, 'update').mockImplementation(((table: any) => {
      const real = realUpdate(table);
      const realSet = real.set.bind(real);
      real.set = ((vals: any) => {
        const q = realSet(vals);
        const realWhere = q.where.bind(q);
        q.where = ((cond: any) => {
          const w = realWhere(cond);
          if ((w as any).returning) {
            (w as any).returning = () => Promise.reject(new Error('finalization write failed'));
          }
          return w;
        }) as any;
        return q;
      }) as any;
      return real;
    }) as any);
    await expect(h.svc.send(h.user, BOOK)).rejects.toMatchObject({ statusCode: 500 });
    vi.restoreAllMocks();
    expect((await h.rowsFor(BOOK))[0]?.status).toBe('started');

    // The orphan costs a slot for EVERY book, not just its own.
    h.advance(KINDLE_SEND_START_WINDOW_MS + 1);
    expect(await h.svc.send(h.user, 'bk_different')).toEqual({ outcome: 'quota_exhausted' });

    // Once past the lease, the next admission for that user sweeps it BEFORE the counts run…
    h.advance(KINDLE_SEND_LEASE_MS + 1);
    expect((await h.svc.send(h.user, 'bk_different')).outcome).toBe('sent');
    expect((await h.rowsFor(BOOK))[0]).toMatchObject({ status: 'indeterminate', failureCode: 'lease_expired' });
    // …and the SAME book stays blocked for a further replay window after that sweep.
    expect(await h.svc.send(h.user, BOOK)).toEqual({ outcome: 'indeterminate' });
    h.advance(KINDLE_SEND_REPLAY_WINDOW_MS + 1);
    await h.db.delete(kindleSends).where(eq(kindleSends.status, 'sent'));
    expect((await h.svc.send(h.user, BOOK)).outcome).toBe('sent');
  });

  it('a WEDGED over-lease owner is not swept out from under itself by another user’s admission', async () => {
    const h = await buildKindleSendHarness();
    const other = await h.addUser();
    const gate = deferred<void>();
    h.transports.reply = async (message) => {
      await gate.promise;
      return { accepted: [message.to], rejected: [] };
    };
    const wedged = h.svc.send(h.user, BOOK);
    await flush();
    // The section outlives the lease: the SMTP window is uncancellable, so this is legal.
    h.advance(KINDLE_SEND_LEASE_MS + 60_000);

    h.transports.reply = (message) => Promise.resolve({ accepted: [message.to], rejected: [] });
    expect((await h.svc.send(other, OTHER)).outcome).toBe('sent');
    // The other user's sweep is scoped to THEIR rows, so the wedged row survives…
    expect((await h.rowsFor(BOOK))[0]?.status).toBe('started');

    // …and the wedged user's own queued attempt cannot run its sweep either — it is behind the
    // mutex the wedged attempt still holds.
    let queuedSettled = false;
    const queued = h.svc.send(h.user, 'bk_queued').then((r) => {
      queuedSettled = true;
      return r;
    });
    await flush();
    expect(queuedSettled).toBe(false);
    expect((await h.rowsFor(BOOK))[0]?.status).toBe('started');

    gate.resolve();
    expect(await wedged).toEqual({ outcome: 'sent' });
    await queued;
  });
});
