import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { RequestService, sanitizeAutoApproveRoles, type RequestPolicy, type RequestFailureNotifyDeps } from './request.service.js';
import { NarratorrError, type INarratorrClient } from './narratorr-client.js';
import { UserService } from './user.service.js';
import type { Notifier, NotificationPayload } from './notifications/index.js';
import type { NotifierLogger } from './notifications/types.js';
import type { RequesterEmailArgs, RequesterEmailSender } from './notifications/requester-email.js';
import { createTestDb, insertUser } from '../test-support/db.js';
import { requests, users } from '../../db/schema.js';
import type { NotifiableTransition } from '../../shared/schemas/user.js';
import type { Db } from '../../db/client.js';
import type { V1Book } from '../../shared/schemas/v1/books.js';
import type { V1System } from '../../shared/schemas/v1/system.js';
import type { BookStatus } from '../../shared/schemas/book.js';
import type { CreateRequestBody, RequestStatus } from '../../shared/schemas/request.js';

/** Configurable fake — controls the book status the handoff/poll observes. */
class FakeClient implements INarratorrClient {
  status: BookStatus = 'searching';
  throwOnAdd: Error | null = null;
  added: string[] = [];
  private seq = 0;

  async searchMetadata() {
    return [];
  }
  async addBook(asin: string): Promise<V1Book> {
    this.added.push(asin);
    if (this.throwOnAdd) throw this.throwOnAdd;
    this.seq += 1;
    return { id: `bk_${this.seq}`, title: 'A Book', authors: [], narrators: [], status: this.status };
  }
  async getBook(id: string): Promise<V1Book> {
    return { id, title: 'A Book', authors: [], narrators: [], status: this.status };
  }
  async getSystem(): Promise<V1System> {
    return { version: 'v1.0.0' };
  }
}

const body = (asin: string, title = 'A Book'): CreateRequestBody => ({
  asin,
  title,
  author: 'Author',
  narrator: null,
  coverUrl: null,
  note: null,
});

const policy = (over: Partial<RequestPolicy> = {}): RequestPolicy => ({
  defaultQuota: { mode: 'limited', limit: 10 },
  windowDays: 30,
  autoApproveRoles: ['admin'],
  ...over,
});

let db: Db;
let client: FakeClient;

beforeEach(async () => {
  db = await createTestDb();
  client = new FakeClient();
});

describe('RequestService.create', () => {
  it('creates a pending request for a normal user', async () => {
    const user = await insertUser(db, { role: 'user' });
    const svc = new RequestService(db, client, policy());
    const { row, created } = await svc.create(user.id, body('B1'));
    expect(created).toBe(true);
    expect(row.status).toBe('pending');
    expect(client.added).toHaveLength(0); // no handoff until approved
  });

  it('de-dupes an active request for the same (user, asin)', async () => {
    const user = await insertUser(db, { role: 'user' });
    const svc = new RequestService(db, client, policy());
    const first = await svc.create(user.id, body('B1'));
    const second = await svc.create(user.id, body('B1'));
    expect(second.created).toBe(false);
    expect(second.row.publicId).toBe(first.row.publicId);
  });

  it('auto-approves an admin and hands off immediately', async () => {
    const admin = await insertUser(db, { role: 'admin' });
    const svc = new RequestService(db, client, policy());
    const { row } = await svc.create(admin.id, body('B1'));
    expect(row.status).toBe('acquiring');
    expect(row.narratorrBookId).toBe('bk_1');
    expect(client.added).toEqual(['B1']); // idempotent by ASIN — no key needed
  });

  it('short-circuits to available when the book is already imported', async () => {
    const admin = await insertUser(db, { role: 'admin' });
    client.status = 'imported';
    const svc = new RequestService(db, client, policy());
    const { row } = await svc.create(admin.id, body('B1'));
    expect(row.status).toBe('available');
  });

  it('auto-approves a per-user flagged (non-admin) user and hands off', async () => {
    const user = await insertUser(db, { role: 'user', autoApprove: true });
    const svc = new RequestService(db, client, policy());
    const { row } = await svc.create(user.id, body('B1'));
    expect(row.status).toBe('acquiring'); // skipped pending → handed off (FakeClient → searching)
    expect(client.added).toEqual(['B1']);
  });

  it('still enforces quota for an auto-approve user (auto-approve ≠ unlimited)', async () => {
    const user = await insertUser(db, { role: 'user', autoApprove: true });
    const svc = new RequestService(db, client, policy({ defaultQuota: { mode: 'limited', limit: 1 } }));
    await svc.create(user.id, body('B1'));
    await expect(svc.create(user.id, body('B2'))).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
  });
});

describe('list — admin queue status filter', () => {
  const seedAll = async (userId: number) => {
    const statuses: RequestStatus[] = ['pending', 'approved', 'acquiring', 'available', 'denied', 'failed'];
    for (const status of statuses) {
      await db.insert(requests).values({ publicId: `rq_${status}`, userId, asin: status, title: status, status });
    }
  };

  it('"approved" returns the whole post-approval lifecycle, not just the transient approved row', async () => {
    const user = await insertUser(db, { role: 'user' });
    const svc = new RequestService(db, client, policy());
    await seedAll(user.id);

    const approved = await svc.list({ status: 'approved', limit: 50, offset: 0 });
    expect(approved.total).toBe(3);
    expect(new Set(approved.data.map((r) => r.status))).toEqual(new Set(['approved', 'acquiring', 'available']));
  });

  it('every other status still filters exactly — no grouping leak', async () => {
    const user = await insertUser(db, { role: 'user' });
    const svc = new RequestService(db, client, policy());
    await seedAll(user.id);

    for (const status of ['pending', 'available', 'denied', 'failed'] as const) {
      const res = await svc.list({ status, limit: 50, offset: 0 });
      expect(res.data.map((r) => r.status)).toEqual([status]);
    }
  });
});

describe('list — offset paging + tie-stability (AC1/AC4)', () => {
  /** Insert one request row directly (single statement — :memory: libSQL breaks across
   *  db.transaction() per CLAUDE.md). `requestedAt` is settable to force second-resolution ties. */
  const seedRequest = (userId: number, asin: string, requestedAt?: Date) =>
    db.insert(requests).values({
      publicId: `rq_${asin}`,
      userId,
      asin,
      title: asin,
      status: 'pending',
      ...(requestedAt ? { requestedAt } : {}),
    });

  it('default page returns 50 rows with total = the full seeded count (unfiltered by the page limit)', async () => {
    const user = await insertUser(db, { role: 'user' });
    for (let i = 0; i < 55; i++) await seedRequest(user.id, `b${i}`);
    const svc = new RequestService(db, client, policy());

    const first = await svc.list({ userId: user.id, limit: 50, offset: 0 });
    expect(first.data).toHaveLength(50);
    expect(first.total).toBe(55); // total counts all matching rows, not just the page
  });

  it('adjacent offset pages cover the whole set with no overlap and no missing rows', async () => {
    const user = await insertUser(db, { role: 'user' });
    for (let i = 0; i < 55; i++) await seedRequest(user.id, `b${i}`);
    const svc = new RequestService(db, client, policy());

    const page1 = await svc.list({ userId: user.id, limit: 50, offset: 0 });
    const page2 = await svc.list({ userId: user.id, limit: 50, offset: 50 });
    expect(page2.data).toHaveLength(5); // last page = the remainder

    const ids = [...page1.data, ...page2.data].map((r) => r.publicId);
    expect(new Set(ids).size).toBe(55); // no duplicate publicId across the pages
  });

  it('tie stability: rows sharing a requestedAt second page in the exact desc(id) tiebreak order', async () => {
    const user = await insertUser(db, { role: 'user' });
    // All 12 rows share the SAME requestedAt second. Insert t0..t11 in order, so their
    // autoincrement ids ascend with the suffix. The secondary sort key desc(requests.id)
    // must therefore produce the strict reverse: t11, t10, …, t0.
    const tied = new Date('2026-01-01T00:00:00.000Z');
    for (let i = 0; i < 12; i++) await seedRequest(user.id, `t${i}`, tied);
    const svc = new RequestService(db, client, policy());

    const seen: string[] = [];
    for (let offset = 0; offset < 12; offset += 5) {
      const page = await svc.list({ userId: user.id, limit: 5, offset });
      seen.push(...page.data.map((r) => r.publicId));
    }
    // Assert the CONCRETE tiebreak order, not just the distinct set: if desc(requests.id)
    // were dropped, SQLite would fall back to ascending rowid (t0…t11) among the ties and
    // this exact sequence would fail — so the assertion is mutation-sensitive to AC4's key.
    const expected = Array.from({ length: 12 }, (_, i) => `rq_t${11 - i}`);
    expect(seen).toEqual(expected);
    // And, as a corollary, the pages neither drop nor duplicate a tied row.
    expect(new Set(seen).size).toBe(12);
  });

  it('total respects the status filter — it counts filtered rows, not the table grand total', async () => {
    const user = await insertUser(db, { role: 'user' });
    // 3 rows in the approved lifecycle (APPROVED_REQUEST_STATUSES) + 2 pending.
    await db.insert(requests).values({ publicId: 'rq_a', userId: user.id, asin: 'a', title: 'a', status: 'approved' });
    await db.insert(requests).values({ publicId: 'rq_b', userId: user.id, asin: 'b', title: 'b', status: 'acquiring' });
    await db.insert(requests).values({ publicId: 'rq_c', userId: user.id, asin: 'c', title: 'c', status: 'available' });
    await db.insert(requests).values({ publicId: 'rq_d', userId: user.id, asin: 'd', title: 'd', status: 'pending' });
    await db.insert(requests).values({ publicId: 'rq_e', userId: user.id, asin: 'e', title: 'e', status: 'pending' });
    const svc = new RequestService(db, client, policy());

    const approved = await svc.list({ userId: user.id, status: 'approved', limit: 50, offset: 0 });
    expect(approved.total).toBe(3); // only the APPROVED_REQUEST_STATUSES rows, not all 5
    expect(approved.data).toHaveLength(3);
  });
});

describe('insert-time unique-violation race', () => {
  // The preflight findActiveDuplicate() at create():154 returns before insertRequest(),
  // so a pre-seeded duplicate alone only retests preflight dedupe and never reaches the
  // catch at insertRequest():225-232. Simulate the race window explicitly: drive the DB
  // read seam (db.query.requests.findFirst) so preflight MISSES and the catch re-query
  // HITS, and make the insert throw the unique violation. (:memory: libSQL breaks across
  // db.transaction() per CLAUDE.md, so a spy is preferred over real concurrency.)
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves the race to the existing duplicate — no new row, no handoff', async () => {
    // Drive an AUTO-APPROVE caller (admin) against an `approved` duplicate so the
    // no-handoff assertion is mutation-sensitive: create() returns at :163 (`!created`)
    // BEFORE the auto-approve handoff at :164. handoff() only acts on an `approved` row,
    // so if that early return were ever removed, handoff(dupe) would fire addBook here —
    // a `pending` duplicate would no-op in handoff() and mask the regression. `approved`
    // is an active status covered by the partial unique index.
    const admin = await insertUser(db, { role: 'admin' });
    // Seed the duplicate directly — direct db.insert does not touch FakeClient.added.
    const [seeded] = await db
      .insert(requests)
      .values({ publicId: 'rq_dupe', userId: admin.id, asin: 'B1', title: 't', status: 'approved' })
      .returning();

    // Preflight (create():154) misses; catch re-query (insertRequest():228) hits the seed.
    vi.spyOn(db.query.requests, 'findFirst')
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(seeded);
    // The insert trips the partial unique index between preflight and write.
    vi.spyOn(db, 'insert').mockImplementation(() => {
      throw new Error('UNIQUE constraint failed: requests.user_id, requests.asin');
    });

    const svc = new RequestService(db, client, policy());
    const { row, created } = await svc.create(admin.id, body('B1'));

    expect(created).toBe(false);
    expect(row.publicId).toBe(seeded!.publicId); // returns the existing duplicate
    // No handoff for the raced call: an approved dupe handed to handoff() WOULD call
    // addBook, so length 0 proves create() short-circuited before handoff / re-charge.
    expect(client.added).toHaveLength(0);

    // No second row was written for the (user, asin) pair.
    vi.restoreAllMocks();
    const rows = await db
      .select()
      .from(requests)
      .where(and(eq(requests.userId, admin.id), eq(requests.asin, 'B1')));
    expect(rows).toHaveLength(1);
  });

  it('re-throws the original error when the catch re-query finds no duplicate (no silent null)', async () => {
    const user = await insertUser(db, { role: 'user' });
    // Both preflight and catch re-query miss; the unique violation must surface unchanged.
    vi.spyOn(db.query.requests, 'findFirst')
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);
    vi.spyOn(db, 'insert').mockImplementation(() => {
      throw new Error('UNIQUE constraint failed: requests.user_id, requests.asin');
    });

    const svc = new RequestService(db, client, policy());
    await expect(svc.create(user.id, body('B1'))).rejects.toThrow('UNIQUE constraint failed');
  });
});

describe('quota enforcement (rolling window)', () => {
  it('blocks a normal user past their limit but never an auto-approve admin', async () => {
    const user = await insertUser(db, { role: 'user' });
    const svc = new RequestService(db, client, policy({ defaultQuota: { mode: 'limited', limit: 1 } }));
    await svc.create(user.id, body('B1'));
    await expect(svc.create(user.id, body('B2'))).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });

    const admin = await insertUser(db, { role: 'admin' });
    await expect(svc.create(admin.id, body('B3'))).resolves.toBeTruthy();
  });

  it('rejects a blocked user with 403 QUOTA_BLOCKED (distinct from the at-cap 429), regardless of usage', async () => {
    const blocked = await insertUser(db, { role: 'user', requestQuota: { mode: 'blocked' } });
    const svc = new RequestService(db, client, policy({ defaultQuota: { mode: 'limited', limit: 10 } }));
    await expect(svc.create(blocked.id, body('B1'))).rejects.toMatchObject({
      statusCode: 403,
      code: 'QUOTA_BLOCKED',
    });
    // Nothing was written — a hard block stops the request before any insert.
    const rows = await db.select().from(requests).where(eq(requests.userId, blocked.id));
    expect(rows).toHaveLength(0);
  });

  it('a per-user unlimited override imposes no cap even under a limited default', async () => {
    const user = await insertUser(db, { role: 'user', requestQuota: { mode: 'unlimited' } });
    const svc = new RequestService(db, client, policy({ defaultQuota: { mode: 'limited', limit: 1 } }));
    await expect(svc.create(user.id, body('B1'))).resolves.toBeTruthy();
    await expect(svc.create(user.id, body('B2'))).resolves.toBeTruthy(); // no cap despite default of 1
  });

  it('does not count denied or failed requests toward quota', async () => {
    const user = await insertUser(db, { role: 'user' });
    const svc = new RequestService(db, client, policy({ defaultQuota: { mode: 'limited', limit: 10 } }));
    // Seed four requests in various terminal states.
    await db.insert(requests).values([
      { publicId: 'rq_open', userId: user.id, asin: 'A1', title: 't', status: 'pending' },
      { publicId: 'rq_denied', userId: user.id, asin: 'A2', title: 't', status: 'denied' },
      { publicId: 'rq_fail1', userId: user.id, asin: 'A3', title: 't', status: 'failed' },
      { publicId: 'rq_fail2', userId: user.id, asin: 'A4', title: 't', status: 'failed' },
    ]);
    const usage = await svc.quotaUsage(user.id, { mode: 'limited', limit: 10 });
    expect(usage.used).toBe(1); // only the pending row; denied + both failed refund
    expect(usage.remaining).toBe(9);
  });

  it('reports unlimited for auto-approve roles (limit & remaining null)', async () => {
    const admin = await insertUser(db, { role: 'admin' });
    const svc = new RequestService(db, client, policy({ defaultQuota: { mode: 'limited', limit: 1 } }));
    expect(svc.resolveQuota({ role: 'admin', requestQuotaMode: 'limited', requestQuotaLimit: 5 })).toEqual({ mode: 'unlimited' });
    const usage = await svc.quotaUsage(admin.id, svc.resolveQuota({ role: 'admin', requestQuotaMode: 'inherit', requestQuotaLimit: null }));
    expect(usage.mode).toBe('unlimited');
    expect(usage.limit).toBeNull();
    expect(usage.remaining).toBeNull();
  });
});

describe('resolveQuota — mode resolution + configured-default sourcing', () => {
  it('inherits the configured limited default for a non-override, non-admin user', () => {
    const svc = new RequestService(db, client, policy({ defaultQuota: { mode: 'limited', limit: 7 } }));
    expect(svc.resolveQuota({ role: 'user', requestQuotaMode: 'inherit', requestQuotaLimit: null })).toEqual({ mode: 'limited', limit: 7 });
  });

  it('a per-user limited override still wins over the configured default', () => {
    const svc = new RequestService(db, client, policy({ defaultQuota: { mode: 'limited', limit: 7 } }));
    expect(svc.resolveQuota({ role: 'user', requestQuotaMode: 'limited', requestQuotaLimit: 2 })).toEqual({ mode: 'limited', limit: 2 });
  });

  it('a per-user unlimited override imposes no cap even when the default is limited', () => {
    const svc = new RequestService(db, client, policy({ defaultQuota: { mode: 'limited', limit: 7 } }));
    expect(svc.resolveQuota({ role: 'user', requestQuotaMode: 'unlimited', requestQuotaLimit: null })).toEqual({ mode: 'unlimited' });
  });

  it('a per-user blocked override resolves to blocked', () => {
    const svc = new RequestService(db, client, policy({ defaultQuota: { mode: 'limited', limit: 7 } }));
    expect(svc.resolveQuota({ role: 'user', requestQuotaMode: 'blocked', requestQuotaLimit: null })).toEqual({ mode: 'blocked' });
  });

  it('inherit with an unlimited default imposes no cap on a fall-through user', () => {
    const svc = new RequestService(db, client, policy({ defaultQuota: { mode: 'unlimited' } }));
    expect(svc.resolveQuota({ role: 'user', requestQuotaMode: 'inherit', requestQuotaLimit: null })).toEqual({ mode: 'unlimited' });
  });
});

describe('quotaUsage — configured rolling window', () => {
  const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);

  it('counts only requests inside the configured window (cutoff uses windowDays)', async () => {
    const user = await insertUser(db, { role: 'user' });
    const svc = new RequestService(db, client, policy({ windowDays: 7 }));
    await db.insert(requests).values([
      { publicId: 'rq_in', userId: user.id, asin: 'A1', title: 't', status: 'pending', requestedAt: daysAgo(6) },
      { publicId: 'rq_out', userId: user.id, asin: 'A2', title: 't', status: 'pending', requestedAt: daysAgo(8) },
    ]);
    const usage = await svc.quotaUsage(user.id, { mode: 'limited', limit: 10 });
    expect(usage.used).toBe(1); // only the in-window request
    expect(usage.windowDays).toBe(7);
  });

  it('a wider window includes a request a narrower one excludes (1 vs 7 vs 30)', async () => {
    const user = await insertUser(db, { role: 'user' });
    await db
      .insert(requests)
      .values({ publicId: 'rq_x', userId: user.id, asin: 'A1', title: 't', status: 'pending', requestedAt: daysAgo(10) });
    expect((await new RequestService(db, client, policy({ windowDays: 1 })).quotaUsage(user.id, { mode: 'limited', limit: 10 })).used).toBe(0);
    expect((await new RequestService(db, client, policy({ windowDays: 7 })).quotaUsage(user.id, { mode: 'limited', limit: 10 })).used).toBe(0);
    expect((await new RequestService(db, client, policy({ windowDays: 30 })).quotaUsage(user.id, { mode: 'limited', limit: 10 })).used).toBe(1);
  });
});

describe('reconfigureQuota — live settings save', () => {
  it('updates the default limit + window applied to fall-through users', async () => {
    const user = await insertUser(db, { role: 'user' });
    const svc = new RequestService(db, client, policy({ defaultQuota: { mode: 'limited', limit: 10 }, windowDays: 30 }));
    expect(svc.resolveQuota({ role: 'user', requestQuotaMode: 'inherit', requestQuotaLimit: null })).toEqual({ mode: 'limited', limit: 10 });

    svc.reconfigureQuota({ mode: 'limited', limit: 1, windowDays: 7 });
    expect(svc.resolveQuota({ role: 'user', requestQuotaMode: 'inherit', requestQuotaLimit: null })).toEqual({ mode: 'limited', limit: 1 });
    expect((await svc.quotaUsage(user.id, { mode: 'limited', limit: 1 })).windowDays).toBe(7);
  });

  it('can switch the default to unlimited live', () => {
    const svc = new RequestService(db, client, policy({ defaultQuota: { mode: 'limited', limit: 10 } }));
    svc.reconfigureQuota({ mode: 'unlimited', windowDays: 30 });
    expect(svc.resolveQuota({ role: 'user', requestQuotaMode: 'inherit', requestQuotaLimit: null })).toEqual({ mode: 'unlimited' });
  });

  it('does not subject admins or per-user overrides to the new default', () => {
    const svc = new RequestService(db, client, policy());
    svc.reconfigureQuota({ mode: 'limited', limit: 1, windowDays: 1 });
    expect(svc.resolveQuota({ role: 'admin', requestQuotaMode: 'inherit', requestQuotaLimit: null })).toEqual({ mode: 'unlimited' });
    expect(svc.resolveQuota({ role: 'user', requestQuotaMode: 'limited', requestQuotaLimit: 5 })).toEqual({ mode: 'limited', limit: 5 });
  });
});

describe('admin decisions + handoff', () => {
  it('approve transitions pending → acquiring; deny → denied', async () => {
    const user = await insertUser(db, { role: 'user' });
    const admin = await insertUser(db, { role: 'admin' });
    const svc = new RequestService(db, client, policy());

    const a = await svc.create(user.id, body('B1'));
    const approved = await svc.decide(admin.id, a.row.publicId, { action: 'approve', note: null });
    expect(approved.status).toBe('acquiring');
    expect(approved.decidedBy).toBe(admin.id);

    const b = await svc.create(user.id, body('B2'));
    const denied = await svc.decide(admin.id, b.row.publicId, { action: 'deny', note: 'nope' });
    expect(denied.status).toBe('denied');
  });

  it('rejects deciding a non-pending request', async () => {
    const user = await insertUser(db, { role: 'user' });
    const admin = await insertUser(db, { role: 'admin' });
    const svc = new RequestService(db, client, policy());
    const a = await svc.create(user.id, body('B1'));
    await svc.decide(admin.id, a.row.publicId, { action: 'approve', note: null });
    await expect(svc.decide(admin.id, a.row.publicId, { action: 'deny', note: null })).rejects.toMatchObject({
      code: 'NOT_PENDING',
    });
  });

  it('serializes concurrent decisions — exactly one wins, the other gets NOT_PENDING', async () => {
    const user = await insertUser(db, { role: 'user' });
    const admin = await insertUser(db, { role: 'admin' });
    const svc = new RequestService(db, client, policy());
    const a = await svc.create(user.id, body('B1'));
    const results = await Promise.allSettled([
      svc.decide(admin.id, a.row.publicId, { action: 'approve', note: null }),
      svc.decide(admin.id, a.row.publicId, { action: 'deny', note: null }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: 'NOT_PENDING' });
  });

  it('fails a request (refundable) on a TERMINAL handoff error (422), and re-throws', async () => {
    const admin = await insertUser(db, { role: 'admin' });
    client.throwOnAdd = new NarratorrError(422, 'asin_not_resolved', 'unresolvable asin');
    const svc = new RequestService(db, client, policy());
    await expect(svc.create(admin.id, body('B1'))).rejects.toBeInstanceOf(NarratorrError);
    const [row] = await db.select().from(requests).where(eq(requests.asin, 'B1'));
    expect(row?.status).toBe('failed');
  });

  it('leaves a request `approved` on a TRANSIENT handoff error (5xx) for the poller to retry', async () => {
    const admin = await insertUser(db, { role: 'admin' });
    client.throwOnAdd = new NarratorrError(502, 'UPSTREAM', 'down');
    const svc = new RequestService(db, client, policy());
    await expect(svc.create(admin.id, body('B1'))).rejects.toBeInstanceOf(NarratorrError);
    const [row] = await db.select().from(requests).where(eq(requests.asin, 'B1'));
    expect(row?.status).toBe('approved'); // stranded — findApprovedAwaitingHandoff retries it
    expect(row?.narratorrBookId).toBeNull();
    expect(row?.failureReason).toBeNull(); // transient writes no reason
  });
});

describe('handoff failure reasons (friendly per-code add-handoff errors)', () => {
  // Each terminal code → its friendly reason on the persisted row, refundable, no book id,
  // and the error still re-throws. A fresh approved request starts with no book, so
  // `narratorrBookId` must remain null (untouched) on the failed row.
  const cases: Array<{ code: string; expected: string }> = [
    { code: 'edition_rejected', expected: "This edition is excluded by the library's filters." },
    { code: 'asin_not_resolved', expected: "Couldn't find this book in the catalog." },
    { code: 'invalid_record', expected: 'Incomplete book data from the provider.' },
  ];

  for (const { code, expected } of cases) {
    it(`maps a 422 ${code} to its friendly reason on the failed row`, async () => {
      const admin = await insertUser(db, { role: 'admin' });
      client.throwOnAdd = new NarratorrError(422, code, 'gate rejected');
      const svc = new RequestService(db, client, policy());
      await expect(svc.create(admin.id, body('B1'))).rejects.toBeInstanceOf(NarratorrError);
      const [row] = await db.select().from(requests).where(eq(requests.asin, 'B1'));
      expect(row?.status).toBe('failed');
      expect(row?.failureReason).toBe(expected);
      expect(row?.narratorrBookId).toBeNull();
    });
  }

  it('falls back to a readable `code: message` for an unknown terminal code (no crash)', async () => {
    const admin = await insertUser(db, { role: 'admin' });
    client.throwOnAdd = new NarratorrError(422, 'some_new_code', 'a brand new reason');
    const svc = new RequestService(db, client, policy());
    await expect(svc.create(admin.id, body('B1'))).rejects.toBeInstanceOf(NarratorrError);
    const [row] = await db.select().from(requests).where(eq(requests.asin, 'B1'));
    expect(row?.status).toBe('failed');
    expect(row?.failureReason).toBe('some_new_code: a brand new reason');
  });

  it('uses the generic fallback reason for a non-NarratorrError terminal throw', async () => {
    const admin = await insertUser(db, { role: 'admin' });
    client.throwOnAdd = new Error('db exploded');
    const svc = new RequestService(db, client, policy());
    await expect(svc.create(admin.id, body('B1'))).rejects.toThrow('db exploded');
    const [row] = await db.select().from(requests).where(eq(requests.asin, 'B1'));
    expect(row?.status).toBe('failed');
    expect(row?.failureReason).toBe('handoff failed');
  });

  it('writes a friendly reason when the added book itself comes back failed/missing', async () => {
    const admin = await insertUser(db, { role: 'admin' });
    client.status = 'missing'; // addBook resolves a book already in a terminal-failed state
    const svc = new RequestService(db, client, policy());
    const { row } = await svc.create(admin.id, body('B1'));
    expect(row.status).toBe('failed');
    const [fresh] = await db.select().from(requests).where(eq(requests.asin, 'B1'));
    expect(fresh?.failureReason).toBe('No source found upstream.');
  });
});

describe('request.failed notification (#60)', () => {
  // A recording notifier behind a mutable holder, so a test can swap the live notifier
  // and prove the failed-emission reads it at dispatch time (no stale capture).
  function harness() {
    const notify = vi.fn(async (_p: NotificationPayload) => {});
    const holder = { current: { notify } as unknown as Notifier };
    const swapped = vi.fn(async (_p: NotificationPayload) => {});
    return {
      notify,
      holder,
      swapped,
      /** Wiring with the real UserService (resolves the inserted requester's username). */
      deps: (): RequestFailureNotifyDeps => ({ getNotifier: () => holder.current, users: new UserService(db) }),
      /** Wiring whose user lookup always misses (deleted-account case). */
      depsNoRequester: (): RequestFailureNotifyDeps => ({
        getNotifier: () => holder.current,
        users: { getById: async () => undefined },
      }),
    };
  }

  const failedPayload = (notify: ReturnType<typeof vi.fn>): NotificationPayload =>
    notify.mock.calls.find((c) => (c[0] as NotificationPayload).event === 'request.failed')?.[0] as NotificationPayload;

  it('emits request.failed once on a TERMINAL handoff error, and still rethrows', async () => {
    const h = harness();
    const admin = await insertUser(db, { role: 'admin', username: 'todd' });
    client.throwOnAdd = new NarratorrError(422, 'asin_not_resolved', 'nope');
    const svc = new RequestService(db, client, policy(), h.deps());

    await expect(svc.create(admin.id, body('B1'))).rejects.toBeInstanceOf(NarratorrError); // rethrow preserved
    await vi.waitFor(() => expect(h.notify).toHaveBeenCalledTimes(1));
    expect(failedPayload(h.notify)).toMatchObject({
      event: 'request.failed',
      request: { asin: 'B1', title: 'A Book', author: 'Author' },
      requester: { username: 'todd' },
      reason: "Couldn't find this book in the catalog.",
    });
    const [row] = await db.select().from(requests).where(eq(requests.asin, 'B1'));
    expect(row?.status).toBe('failed');
  });

  it('emits once on a handoff that resolves a terminal-failed book AND preserves narratorrBookId', async () => {
    const h = harness();
    const admin = await insertUser(db, { role: 'admin', username: 'todd' });
    client.status = 'missing'; // addBook resolves a book already terminal-failed → mapBookStatus → failed
    const svc = new RequestService(db, client, policy(), h.deps());

    const { row } = await svc.create(admin.id, body('B1'));
    expect(row.status).toBe('failed');
    expect(row.narratorrBookId).toBe('bk_1'); // book linkage NOT dropped by the failed transition
    await vi.waitFor(() => expect(h.notify).toHaveBeenCalledTimes(1));
    expect(failedPayload(h.notify)).toMatchObject({ event: 'request.failed', reason: 'No source found upstream.' });
  });

  it('emits once via applyBook (poller reconciliation) when a polled book goes failed', async () => {
    const h = harness();
    const user = await insertUser(db, { role: 'user', username: 'todd' });
    const svc = new RequestService(db, client, policy(), h.deps());
    const { row } = await svc.create(user.id, body('B1'));

    const book: V1Book = { id: 'bk_1', title: 't', authors: [], narrators: [], status: 'failed' };
    const next = await svc.applyBook(row, book);
    expect(next).toBe('failed');
    await vi.waitFor(() => expect(h.notify).toHaveBeenCalledTimes(1));
    expect(failedPayload(h.notify)).toMatchObject({
      event: 'request.failed',
      reason: 'Download failed upstream.',
      requester: { username: 'todd' },
    });

    // Re-applying the already-failed book is not a transition → no re-emit.
    const again = await svc.applyBook(row, book);
    expect(again).toBeNull();
    await new Promise((r) => setTimeout(r, 10));
    expect(h.notify).toHaveBeenCalledTimes(1);
  });

  it('emits exactly once when two callers race the same non-failed row (atomic claim)', async () => {
    const h = harness();
    const user = await insertUser(db, { role: 'user', username: 'todd' });
    const svc = new RequestService(db, client, policy(), h.deps());
    const { row } = await svc.create(user.id, body('B1'));

    const [a, b] = await Promise.all([
      svc.markFailed(row, 'gone'),
      svc.markFailed(row, 'gone'),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1); // only one caller performed the transition
    await vi.waitFor(() => expect(h.notify).toHaveBeenCalledTimes(1));
  });

  it('two concurrent failed-claims on the same acquiring row: exactly one wins and emits once', async () => {
    const h = harness();
    const admin = await insertUser(db, { role: 'admin', username: 'todd' });
    const svc = new RequestService(db, client, policy(), h.deps());
    const { row } = await svc.create(admin.id, body('B1')); // admin auto-approve → handoff → acquiring
    expect(row.status).toBe('acquiring');

    const [a, b] = await Promise.all([svc.markFailed(row, 'gone'), svc.markFailed(row, 'gone')]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    await vi.waitFor(() => expect(h.notify).toHaveBeenCalledTimes(1));
    const [fresh] = await db.select().from(requests).where(eq(requests.id, row.id));
    expect(fresh?.status).toBe('failed');
  });

  it('a stale failed-claim does NOT clobber a row that moved on to a newer terminal state (no emit)', async () => {
    const h = harness();
    const admin = await insertUser(db, { role: 'admin', username: 'todd' });
    const svc = new RequestService(db, client, policy(), h.deps());
    const { row } = await svc.create(admin.id, body('B1')); // acquiring, narratorrBookId set
    expect(row.status).toBe('acquiring');

    // The row moves on to a NEWER terminal state behind the stale caller's back.
    await db.update(requests).set({ status: 'available' }).where(eq(requests.id, row.id));

    // The stale caller still holds the `acquiring` row and tries to fail it → claims zero rows.
    await expect(svc.markFailed(row, 'gone')).resolves.toBe(false);
    const [fresh] = await db.select().from(requests).where(eq(requests.id, row.id));
    expect(fresh?.status).toBe('available'); // newer terminal state preserved, not clobbered to failed
    await new Promise((r) => setTimeout(r, 10));
    expect(h.notify).not.toHaveBeenCalled(); // no request.failed emitted
  });

  it('dispatches through the LIVE notifier after a reconfiguration (no stale capture)', async () => {
    const h = harness();
    const user = await insertUser(db, { role: 'user', username: 'todd' });
    const svc = new RequestService(db, client, policy(), h.deps());
    const { row } = await svc.create(user.id, body('B1'));

    // Simulate settings.ts reassigning deps.notifier to a freshly-built dispatcher.
    h.holder.current = { notify: h.swapped } as unknown as Notifier;
    await svc.markFailed(row, 'gone');

    await vi.waitFor(() => expect(h.swapped).toHaveBeenCalledTimes(1)); // rebuilt notifier got it
    expect(h.notify).not.toHaveBeenCalled(); // original (stale) instance did NOT
  });

  it('still emits with a fallback username when the requester lookup misses, without throwing', async () => {
    // depsNoRequester.getById always returns undefined — the deleted-account case. (Deleting
    // the user row itself would cascade-delete the request, so we drive the lookup miss directly.)
    const h = harness();
    const user = await insertUser(db, { role: 'user', username: 'todd' });
    const svc = new RequestService(db, client, policy(), h.depsNoRequester());
    const { row } = await svc.create(user.id, body('B1'));

    await expect(svc.markFailed(row, 'gone')).resolves.toBe(true); // transition lands, no throw
    await vi.waitFor(() => expect(h.notify).toHaveBeenCalledTimes(1));
    expect(failedPayload(h.notify)).toMatchObject({
      event: 'request.failed',
      requester: { username: '(unknown requester)' },
    });
  });

  it('does not emit when constructed without notify deps (backward-compatible)', async () => {
    const user = await insertUser(db, { role: 'user' });
    const svc = new RequestService(db, client, policy()); // 3-arg, no notifier
    const { row } = await svc.create(user.id, body('B1'));
    await expect(svc.markFailed(row, 'gone')).resolves.toBe(true); // no throw, transition still lands
    const [fresh] = await db.select().from(requests).where(eq(requests.asin, 'B1'));
    expect(fresh?.status).toBe('failed');
  });
});

describe('request.failed emission diagnostics (#68: a lost notification is logged, never thrown)', () => {
  // emitFailed is fire-and-forget: it must NEVER throw into the request/poll path, but a lost
  // notification (rejected requester lookup or rejected dispatch) has to be diagnosable. These
  // wire a warn spy as the deps logger and assert the redacted breadcrumb carries the request id.
  function diagDeps(over: {
    getById?: () => Promise<Awaited<ReturnType<UserService['getById']>>>;
    notify?: (p: NotificationPayload) => Promise<void>;
  }): { deps: RequestFailureNotifyDeps; warn: ReturnType<typeof vi.fn>; notify: ReturnType<typeof vi.fn> } {
    const warn = vi.fn();
    const logger: NotifierLogger = { info() {}, warn, error() {}, debug() {} };
    const notify = vi.fn(over.notify ?? (async (_p: NotificationPayload) => {}));
    const deps: RequestFailureNotifyDeps = {
      getNotifier: () => ({ notify } as unknown as Notifier),
      users: over.getById ? { getById: over.getById } : new UserService(db),
      logger,
    };
    return { deps, warn, notify };
  }

  const warnFor = (warn: ReturnType<typeof vi.fn>, needle: string) =>
    warn.mock.calls.find((c) => String(c[1]).includes(needle));

  it('logs a redacted warn (carrying the request id) when the requester lookup REJECTS, still dispatches with the placeholder, and never throws', async () => {
    const user = await insertUser(db, { role: 'user', username: 'todd' });
    const { deps, warn, notify } = diagDeps({
      getById: async () => {
        throw new Error('db fault');
      },
    });
    const svc = new RequestService(db, client, policy(), deps);
    const { row } = await svc.create(user.id, body('B1'));

    await expect(svc.markFailed(row, 'gone')).resolves.toBe(true); // transition lands, caller never throws

    await vi.waitFor(() => expect(warnFor(warn, 'requester lookup failed')).toBeTruthy());
    expect(warnFor(warn, 'requester lookup failed')?.[0]).toMatchObject({ request: row.publicId });
    // The notification is NOT lost on a lookup fault — it still dispatches with the placeholder.
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(notify.mock.calls[0]![0]).toMatchObject({
      event: 'request.failed',
      requester: { username: '(unknown requester)' },
    });
  });

  it('logs a redacted warn (carrying the request id) when the notifier dispatch REJECTS, with no propagation into the caller', async () => {
    const user = await insertUser(db, { role: 'user', username: 'todd' });
    const { deps, warn, notify } = diagDeps({
      notify: async () => {
        throw new Error('channel down');
      },
    });
    const svc = new RequestService(db, client, policy(), deps);
    const { row } = await svc.create(user.id, body('B1'));

    await expect(svc.markFailed(row, 'gone')).resolves.toBe(true); // caller never sees the dispatch failure
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(warnFor(warn, 'notifier dispatch failed')).toBeTruthy());
    expect(warnFor(warn, 'notifier dispatch failed')?.[0]).toMatchObject({ request: row.publicId });
  });

  it('REDACTS a secret-bearing dispatch error before logging the breadcrumb (capability URL never reaches the log raw)', async () => {
    // A real dispatch fault can embed a capability URL / token-in-path (the leak vector redact()
    // exists for). The error text below carries a Telegram bot token in the URL path; the logged
    // breadcrumb must scrub it. Deleting redact() from emitFailed would fail THIS assertion (the
    // plain-text 'channel down' case above would still pass — it has no secret to scrub).
    const secretToken = 'bot123456789:AA-ZZ_SuperSecretBotTokenValue';
    const user = await insertUser(db, { role: 'user', username: 'todd' });
    const { deps, warn, notify } = diagDeps({
      notify: async () => {
        throw new Error(`fetch failed for https://api.telegram.org/${secretToken}/sendMessage`);
      },
    });
    const svc = new RequestService(db, client, policy(), deps);
    const { row } = await svc.create(user.id, body('B1'));

    await expect(svc.markFailed(row, 'gone')).resolves.toBe(true);
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(warnFor(warn, 'notifier dispatch failed')).toBeTruthy());
    const breadcrumb = warnFor(warn, 'notifier dispatch failed')![0];
    const serialized = JSON.stringify(breadcrumb);
    expect(serialized).not.toContain(secretToken); // token scrubbed
    expect(serialized).not.toContain('SuperSecretBotTokenValue'); // and its value-class fragment
    expect(serialized).toContain('«redacted»'); // replaced by the shared redaction marker
    expect(breadcrumb).toMatchObject({ request: row.publicId });
  });

  it('logs nothing at warn on the happy path (successful lookup + dispatch, emitted once)', async () => {
    const user = await insertUser(db, { role: 'user', username: 'todd' });
    const { deps, warn, notify } = diagDeps({});
    const svc = new RequestService(db, client, policy(), deps);
    const { row } = await svc.create(user.id, body('B1'));

    await svc.markFailed(row, 'gone');
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 10)); // let any stray breadcrumb settle
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('toDto', () => {
  const requester = { publicId: 'us_x', username: 'x' };

  it('maps failureReason onto the DTO (friendly string and null)', async () => {
    const admin = await insertUser(db, { role: 'admin' });
    const svc = new RequestService(db, client, policy());

    const { row: pending } = await svc.create(admin.id, body('B1'));
    expect(svc.toDto(pending, requester).failureReason).toBeNull();

    client.throwOnAdd = new NarratorrError(422, 'edition_rejected', 'nope');
    await expect(svc.create(admin.id, body('B2'))).rejects.toBeInstanceOf(NarratorrError);
    const [failed] = await db.select().from(requests).where(eq(requests.asin, 'B2'));
    expect(svc.toDto(failed!, requester).failureReason).toBe("This edition is excluded by the library's filters.");
  });
});

describe('applyBook (poller reconciliation)', () => {
  const mkBook = (status: BookStatus): V1Book => ({
    id: 'bk_1',
    title: 't',
    authors: [],
    narrators: [],
    status,
  });

  it('drives acquiring → available on imported and acquiring → failed on missing', async () => {
    const user = await insertUser(db, { role: 'user' });
    const svc = new RequestService(db, client, policy());
    const { row } = await svc.create(user.id, body('B1'));

    const toAvailable = await svc.applyBook(row, mkBook('imported'));
    expect(toAvailable).toBe('available');

    const { row: row2 } = await svc.create(user.id, body('B2'));
    const toFailed = await svc.applyBook(row2, mkBook('missing'));
    expect(toFailed).toBe('failed');
  });

  it('writes the friendly book-status reason when a polled book goes failed/missing', async () => {
    const user = await insertUser(db, { role: 'user' });
    const svc = new RequestService(db, client, policy());

    const { row: r1 } = await svc.create(user.id, body('B1'));
    await svc.applyBook(r1, mkBook('failed'));
    const [failed] = await db.select().from(requests).where(eq(requests.asin, 'B1'));
    expect(failed?.failureReason).toBe('Download failed upstream.');

    const { row: r2 } = await svc.create(user.id, body('B2'));
    await svc.applyBook(r2, mkBook('missing'));
    const [missing] = await db.select().from(requests).where(eq(requests.asin, 'B2'));
    expect(missing?.failureReason).toBe('No source found upstream.');
  });

  it('leaves a `wanted` request acquiring indefinitely — no app-side timeout', async () => {
    const admin = await insertUser(db, { role: 'admin' });
    const svc = new RequestService(db, client, policy());
    const { row } = await svc.create(admin.id, body('B1')); // auto-approved → acquiring

    // A not-found book sits `wanted` upstream; we mirror that, never auto-fail on a timer.
    const result = await svc.applyBook(row, mkBook('wanted'));
    expect(result).toBeNull(); // no transition — still acquiring
    const [fresh] = await db.select().from(requests).where(eq(requests.asin, 'B1'));
    expect(fresh?.status).toBe('acquiring');
  });

  it('persists a late-arriving book id while status stays acquiring — returns null but updates narratorrBookId', async () => {
    const user = await insertUser(db, { role: 'user' });
    const svc = new RequestService(db, client, policy());
    const [row] = await db
      .insert(requests)
      .values({
        publicId: 'rq_late',
        userId: user.id,
        asin: 'L1',
        title: 't',
        status: 'acquiring',
        narratorrBookId: 'bk_old',
      })
      .returning();

    // `downloading` maps back to acquiring (status unchanged), but the book id differs:
    // the bookId !== row.narratorrBookId branch falls through the early-return guard,
    // persists the new id, then returns null because `next === row.status`.
    const book: V1Book = { id: 'bk_new', title: 't', authors: [], narrators: [], status: 'downloading' };
    const result = await svc.applyBook(row!, book);

    expect(result).toBeNull(); // no transition — still acquiring
    const [fresh] = await db.select().from(requests).where(eq(requests.id, row!.id));
    expect(fresh?.status).toBe('acquiring');
    expect(fresh?.narratorrBookId).toBe('bk_new'); // late id persisted despite the null return
  });
});

describe('sanitizeAutoApproveRoles — storage-boundary narrowing (tier 5)', () => {
  it('passes a valid role array through unchanged, with no warn', () => {
    const warn = vi.fn();
    expect(sanitizeAutoApproveRoles(['admin', 'user'], { warn })).toEqual(['admin', 'user']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('degrades a non-array to ["admin"] + exactly one warn', () => {
    const warn = vi.fn();
    expect(sanitizeAutoApproveRoles(42, { warn })).toEqual(['admin']);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('degrades a non-array string to ["admin"] + exactly one warn', () => {
    const warn = vi.fn();
    expect(sanitizeAutoApproveRoles('admin', { warn })).toEqual(['admin']);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('degrades an array containing an unrecognized role to ["admin"] + exactly one warn', () => {
    const warn = vi.fn();
    expect(sanitizeAutoApproveRoles(['nope'], { warn })).toEqual(['admin']);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('request available requester email (#50)', () => {
  // A fake sender captures the send-one-email calls; the SMTP-source/render internals are unit-
  // tested separately in requester-email.test.ts. These assert the RequestService emit contract:
  // exactly-once per available transition, from every emit site, opt-in + contact gated, and
  // never throwing into the request/poll flow.
  function availHarness() {
    const send = vi.fn(async (_a: RequesterEmailArgs) => {});
    const warn = vi.fn();
    const logger: NotifierLogger = { info() {}, warn, error() {}, debug() {} };
    const deps = (over: Partial<RequesterEmailSender> = {}): RequestFailureNotifyDeps => ({
      getNotifier: () => ({ notify: async () => {} } as unknown as Notifier),
      users: new UserService(db),
      requesterEmail: { send: over.send ?? send },
      logger,
    });
    return { send, warn, deps };
  }

  /** Opt a seeded user into `available` (or a given set) and set their contact email (nullable). */
  async function optIn(id: number, email: string | null, on: NotifiableTransition[] = ['available']) {
    await db.update(users).set({ email, notifyOn: on }).where(eq(users.id, id));
  }

  const warnFor = (warn: ReturnType<typeof vi.fn>, needle: string) =>
    warn.mock.calls.find((c) => String(c[1]).includes(needle));

  const importedBook: V1Book = { id: 'bk_1', title: 't', authors: [], narrators: [], status: 'imported' };

  /** Seed a request row directly in a given status (bypasses create so tests target one edge). */
  async function seedRequest(userId: number, status: RequestStatus, extra: Record<string, unknown> = {}) {
    const [row] = await db
      .insert(requests)
      .values({ publicId: `rq_${status}_${userId}`, userId, asin: 'B1', title: 'A Book', author: 'Author', status, ...extra })
      .returning();
    return row!;
  }

  it('emits exactly one available email via applyBook (poller edge), to the requester with user-facing content', async () => {
    const h = availHarness();
    const user = await insertUser(db, { role: 'user', username: 'todd' });
    await optIn(user.id, 'todd@example.com');
    const svc = new RequestService(db, client, policy(), h.deps());
    const row = await seedRequest(user.id, 'acquiring', { narratorrBookId: 'bk_1' });

    expect(await svc.applyBook(row, importedBook)).toBe('available');
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(1));
    expect(h.send.mock.calls[0]![0]).toMatchObject({
      to: 'todd@example.com',
      transition: 'available',
      request: { title: 'A Book', author: 'Author' },
    });
  });

  it('emits exactly once via the handoff immediate-available branch (already-imported book)', async () => {
    const h = availHarness();
    const admin = await insertUser(db, { role: 'admin', username: 'todd' });
    await optIn(admin.id, 'todd@example.com');
    client.status = 'imported';
    const svc = new RequestService(db, client, policy(), h.deps());

    const { row } = await svc.create(admin.id, body('B1'));
    expect(row.status).toBe('available');
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(1));
    expect(h.send.mock.calls[0]![0]).toMatchObject({ to: 'todd@example.com', transition: 'available' });
  });

  it('emits exactly once via recoverHandoff on a stranded approved row', async () => {
    const h = availHarness();
    const user = await insertUser(db, { role: 'user', username: 'todd' });
    await optIn(user.id, 'todd@example.com');
    client.status = 'imported';
    const svc = new RequestService(db, client, policy(), h.deps());
    const row = await seedRequest(user.id, 'approved');

    expect(await svc.recoverHandoff(row)).toBe('recovered');
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(1));
  });

  it('sends EXACTLY once under a handler-vs-poller race (handoff + recoverHandoff on the same approved row)', async () => {
    const h = availHarness();
    const user = await insertUser(db, { role: 'user', username: 'todd' });
    await optIn(user.id, 'todd@example.com');
    client.status = 'imported';
    const svc = new RequestService(db, client, policy(), h.deps());
    const row = await seedRequest(user.id, 'approved');

    // Both call addBook (idempotent by ASIN in prod) then race the approved → available claim;
    // the atomic `.returning()` guard lets exactly one land the edge and emit. Removing it double-emits.
    await Promise.all([svc.handoff(row), svc.recoverHandoff(row)]);
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it('does not email a user who opted out', async () => {
    const h = availHarness();
    const user = await insertUser(db, { role: 'user', username: 'todd' });
    await optIn(user.id, 'todd@example.com', []); // has email, but opted into nothing
    const svc = new RequestService(db, client, policy(), h.deps());
    const row = await seedRequest(user.id, 'acquiring', { narratorrBookId: 'bk_1' });

    expect(await svc.applyBook(row, importedBook)).toBe('available');
    await new Promise((r) => setTimeout(r, 20));
    expect(h.send).not.toHaveBeenCalled();
  });

  it('opted-in with a null email is a silent no-op (status still correct, no send, no throw)', async () => {
    const h = availHarness();
    const user = await insertUser(db, { role: 'user', username: 'todd' });
    await optIn(user.id, null); // opted in but no contact
    const svc = new RequestService(db, client, policy(), h.deps());
    const row = await seedRequest(user.id, 'acquiring', { narratorrBookId: 'bk_1' });

    expect(await svc.applyBook(row, importedBook)).toBe('available');
    const [fresh] = await db.select().from(requests).where(eq(requests.id, row.id));
    expect(fresh?.status).toBe('available');
    await new Promise((r) => setTimeout(r, 20));
    expect(h.send).not.toHaveBeenCalled();
  });

  it('a send failure never throws into the flow and never alters the recorded status (logged breadcrumb)', async () => {
    const h = availHarness();
    const send = vi.fn(async () => {
      throw new Error('smtp down');
    });
    const user = await insertUser(db, { role: 'user', username: 'todd' });
    await optIn(user.id, 'todd@example.com');
    const svc = new RequestService(db, client, policy(), h.deps({ send }));
    const row = await seedRequest(user.id, 'acquiring', { narratorrBookId: 'bk_1' });

    expect(await svc.applyBook(row, importedBook)).toBe('available'); // transition unaffected
    const [fresh] = await db.select().from(requests).where(eq(requests.id, row.id));
    expect(fresh?.status).toBe('available');
    await vi.waitFor(() => expect(warnFor(h.warn, 'requester email dispatch failed')).toBeTruthy());
  });

  it('emits nothing when no requesterEmail dep is wired (the failed-only construction is unaffected)', async () => {
    const user = await insertUser(db, { role: 'user', username: 'todd' });
    await optIn(user.id, 'todd@example.com');
    // 3-arg construction: no notify deps at all.
    const svc = new RequestService(db, client, policy());
    const row = await seedRequest(user.id, 'acquiring', { narratorrBookId: 'bk_1' });
    expect(await svc.applyBook(row, importedBook)).toBe('available'); // no throw, transition lands
  });
});
