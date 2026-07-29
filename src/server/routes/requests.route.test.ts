import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildRouteApp, type RouteHarness } from '../test-support/route-harness.js';
import { insertUser } from '../test-support/db.js';
import { registerRequestRoutes } from './requests.js';
import { registerSettingsRoutes } from './settings.js';
import { NarratorrError, type INarratorrClient } from '../services/narratorr-client.js';
import type { V1Book } from '../../shared/schemas/v1/books.js';
import type { V1System } from '../../shared/schemas/v1/system.js';
import type { V1Capabilities } from '../../shared/schemas/v1/capabilities.js';

let h: RouteHarness;
beforeEach(async () => {
  h = await buildRouteApp({ register: registerRequestRoutes, enableTestRoleOverride: true });
});
afterEach(async () => {
  await h.app.close();
  vi.restoreAllMocks();
});

const post = (cookies: Record<string, string>, payload: Record<string, unknown>) =>
  h.app.inject({ method: 'POST', url: '/api/requests', cookies, payload });

describe('POST /api/requests — create', () => {
  it('new pending request → 201 and notifies the admin exactly once', async () => {
    const user = await insertUser(h.db, { role: 'user', status: 'active', username: 'alice' });
    const res = await post(h.cookieFor(user), { asin: 'B01', title: 'A Book' });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ asin: 'B01', title: 'A Book', status: 'pending' });
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'request.created',
        request: expect.objectContaining({ asin: 'B01', title: 'A Book' }),
        requester: { username: 'alice' },
      }),
    );
  });

  it('a duplicate (user, asin) → 200 and does NOT re-notify', async () => {
    const user = await insertUser(h.db, { role: 'user', status: 'active' });
    const cookie = h.cookieFor(user);
    await post(cookie, { asin: 'B01', title: 'A Book' }); // first → pending, notifies once
    h.notify.mockClear();

    const dup = await post(cookie, { asin: 'B01', title: 'A Book' });
    expect(dup.statusCode).toBe(200);
    expect(dup.json().status).toBe('pending');
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('admin create auto-approves → 201 acquiring and does NOT notify', async () => {
    const admin = await insertUser(h.db, { role: 'admin', status: 'active' });
    const res = await post(h.cookieFor(admin), { asin: 'B01', title: 'A Book' });

    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('acquiring'); // handoff resolved via the successful fake client
    expect(h.narratorr.added).toEqual(['B01']);
    expect(h.notify).not.toHaveBeenCalled();
  });
});

// A terminal handoff failure at the create boundary (admin self-request auto-approves → hands off →
// addBook 422 → terminal → row `failed` + request.failed emitted, error rethrown). This exercises the
// route↔service↔notifier wiring for the failed path end-to-end — previously untested at the boundary
// because the harness built RequestService without notify deps (issue #68 AC1).
describe('POST /api/requests — terminal handoff failure emits request.failed', () => {
  /** Auto-approve handoff hits addBook → throws a TERMINAL NarratorrError (422 unresolvable ASIN). */
  class TerminalAddClient implements INarratorrClient {
    async searchMetadata(): Promise<[]> {
      return [];
    }
    async addBook(): Promise<V1Book> {
      throw new NarratorrError(422, 'asin_not_resolved', 'unresolvable');
    }
    async getBook(id: string): Promise<V1Book> {
      return { id, title: 'A Book', authors: [], narrators: [], status: 'searching' };
    }
    async getSystem(): Promise<V1System> {
      return { version: 'v1.0.0' };
    }
    async getCapabilities(): Promise<V1Capabilities> {
      return { companionEpub: { enabled: false } };
    }
  }

  it('admin self-request whose handoff fails terminally → 502 error response AND a single request.failed dispatch', async () => {
    const fh = await buildRouteApp({ register: registerRequestRoutes, narratorr: new TerminalAddClient() });
    try {
      const admin = await insertUser(fh.db, { role: 'admin', status: 'active', username: 'todd' });
      const res = await fh.app.inject({
        method: 'POST',
        url: '/api/requests',
        cookies: fh.cookieFor(admin),
        payload: { asin: 'B01', title: 'A Book' },
      });

      // The terminal handoff error surfaces — NarratorrError maps to a 502 NARRATORR_UPSTREAM envelope.
      expect(res.statusCode).toBe(502);
      expect(res.json().error.code).toBe('NARRATORR_UPSTREAM');

      // …and the admin-facing request.failed fires exactly once with the friendly reason. Emission
      // is fire-and-forget, so the dispatch may settle after the response — wait for it.
      await vi.waitFor(() => expect(fh.notify).toHaveBeenCalledTimes(1));
      expect(fh.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'request.failed',
          request: expect.objectContaining({ asin: 'B01', title: 'A Book' }),
          requester: { username: 'todd' },
          reason: "Couldn't find this book in the catalog.",
        }),
      );

      // The persisted row reflects the terminal failure.
      const failed = await fh.requests.getByPublicId(fh.notify.mock.calls[0]![0].request.publicId);
      expect(failed?.status).toBe('failed');
    } finally {
      await fh.app.close();
    }
  });
});

describe('POST /api/requests — validation', () => {
  let cookie: Record<string, string>;
  beforeEach(async () => {
    const user = await insertUser(h.db, { role: 'user', status: 'active' });
    cookie = h.cookieFor(user);
  });

  it('missing asin or title → 400', async () => {
    expect((await post(cookie, { title: 'A Book' })).statusCode).toBe(400);
    expect((await post(cookie, { asin: 'B01' })).statusCode).toBe(400);
  });

  it('whitespace-only asin or title → 400', async () => {
    expect((await post(cookie, { asin: '   ', title: 'A Book' })).statusCode).toBe(400);
    expect((await post(cookie, { asin: 'B01', title: '   ' })).statusCode).toBe(400);
  });

  it('coverUrl: only public https is accepted (SSRF guard)', async () => {
    const base = { asin: 'B01', title: 'A Book' };
    expect((await post(cookie, { ...base, coverUrl: 'http://example.com/c.jpg' })).statusCode).toBe(400);
    expect((await post(cookie, { ...base, coverUrl: 'javascript:alert(1)' })).statusCode).toBe(400);
    // Internal host: passes the scheme check but must be rejected by the host guard.
    expect((await post(cookie, { ...base, coverUrl: 'https://169.254.169.254' })).statusCode).toBe(400);
    expect((await post(cookie, { ...base, coverUrl: 'https://example.com/c.jpg' })).statusCode).toBe(201);
  });

  it('an unknown key → 400 (.strict body)', async () => {
    expect((await post(cookie, { asin: 'B01', title: 'A Book', bogus: true })).statusCode).toBe(400);
  });

  it('quota exceeded → 429 with QUOTA_EXCEEDED in the error envelope', async () => {
    // A per-user limited cap of 1: the first request fills it, the second exceeds → 429.
    const capped = await insertUser(h.db, { role: 'user', status: 'active', requestQuota: { mode: 'limited', limit: 1 } });
    expect((await post(h.cookieFor(capped), { asin: 'B01', title: 'A Book' })).statusCode).toBe(201);
    const res = await post(h.cookieFor(capped), { asin: 'B02', title: 'Another' });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('QUOTA_EXCEEDED');
  });

  it('blocked user → 403 with QUOTA_BLOCKED (distinct from the at-cap 429)', async () => {
    // A hard admin block is a policy denial, not a rate limit — even the FIRST request is rejected.
    const blocked = await insertUser(h.db, { role: 'user', status: 'active', requestQuota: { mode: 'blocked' } });
    const res = await post(h.cookieFor(blocked), { asin: 'B01', title: 'A Book' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('QUOTA_BLOCKED');
  });
});

describe('default quota sourced from settings (live reconfigure)', () => {
  it("changing the default in Settings changes a non-override user's effective limit on the next request", async () => {
    // Register BOTH settings + request routes against one wired app so a real PUT /connectors
    // flows through reconfigure() → RequestService.reconfigureQuota, then a create observes it.
    const h2 = await buildRouteApp({
      register: (app, deps) => {
        registerSettingsRoutes(app, deps);
        registerRequestRoutes(app, deps);
      },
      enableTestRoleOverride: true,
      policy: { defaultQuota: { mode: 'limited', limit: 10 }, windowDays: 30 },
    });
    try {
      const user = await insertUser(h2.db, { role: 'user', status: 'active' });
      const cookie = h2.cookieFor(user);

      // Tighten the app-wide default to 1 / 7-day window via the admin Settings PUT.
      const put = await h2.app.inject({
        method: 'PUT',
        url: '/api/admin/settings/connectors',
        headers: h2.asRole('admin'),
        payload: { defaultQuota: { mode: 'limited', limit: 1, windowDays: 7 } },
      });
      expect(put.statusCode).toBe(200);
      expect(put.json().defaultQuota).toEqual({ mode: 'limited', limit: 1, windowDays: 7 });

      // The non-override user now gets the new limit of 1: first create ok, second exceeds.
      const create = (asin: string) =>
        h2.app.inject({ method: 'POST', url: '/api/requests', cookies: cookie, payload: { asin, title: 'A Book' } });
      expect((await create('B1')).statusCode).toBe(201);
      const second = await create('B2');
      expect(second.statusCode).toBe(429);
      expect(second.json().error.code).toBe('QUOTA_EXCEEDED');
    } finally {
      await h2.app.close();
    }
  });
});

describe('GET /api/requests — list', () => {
  it('is scoped to the caller — user A never sees user B rows', async () => {
    const a = await insertUser(h.db, { role: 'user', status: 'active', username: 'alice' });
    const b = await insertUser(h.db, { role: 'user', status: 'active', username: 'bob' });
    await h.requests.create(a.id, bodyFor('A1'));
    await h.requests.create(a.id, bodyFor('A2'));
    await h.requests.create(b.id, bodyFor('B1'));

    const res = await h.app.inject({ method: 'GET', url: '/api/requests', cookies: h.cookieFor(a) });
    expect(res.statusCode).toBe(200);
    const { data, total } = res.json();
    expect(total).toBe(2);
    expect(data).toHaveLength(2);
    expect(data.every((r: { requester: { publicId: string } }) => r.requester.publicId === a.publicId)).toBe(true);
  });

  it('passes status/limit/offset through and applies 50/0 defaults when omitted', async () => {
    const a = await insertUser(h.db, { role: 'user', status: 'active' });
    const cookie = h.cookieFor(a);
    const listSpy = vi.spyOn(h.requests, 'list').mockResolvedValue({ data: [], total: 0 });

    await h.app.inject({ method: 'GET', url: '/api/requests?status=pending&limit=5&offset=2', cookies: cookie });
    expect(listSpy).toHaveBeenLastCalledWith({ userId: a.id, status: 'pending', limit: 5, offset: 2 });

    await h.app.inject({ method: 'GET', url: '/api/requests', cookies: cookie });
    expect(listSpy).toHaveBeenLastCalledWith({ userId: a.id, limit: 50, offset: 0 });
  });

  it('limit=0 → 400 (rejected by the query schema before the handler)', async () => {
    const a = await insertUser(h.db, { role: 'user', status: 'active' });
    const res = await h.app.inject({ method: 'GET', url: '/api/requests?limit=0', cookies: h.cookieFor(a) });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/requests/:publicId — detail', () => {
  it('owner → 200, other non-admin → 403, admin → 200', async () => {
    const owner = await insertUser(h.db, { role: 'user', status: 'active', username: 'owner' });
    const other = await insertUser(h.db, { role: 'user', status: 'active', username: 'other' });
    const admin = await insertUser(h.db, { role: 'admin', status: 'active', username: 'admin' });
    const { row } = await h.requests.create(owner.id, bodyFor('B01'));
    const url = `/api/requests/${row.publicId}`;

    expect((await h.app.inject({ method: 'GET', url, cookies: h.cookieFor(owner) })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'GET', url, cookies: h.cookieFor(other) })).statusCode).toBe(403);
    expect((await h.app.inject({ method: 'GET', url, cookies: h.cookieFor(admin) })).statusCode).toBe(200);
  });

  it('unknown publicId → 404', async () => {
    const a = await insertUser(h.db, { role: 'user', status: 'active' });
    const res = await h.app.inject({ method: 'GET', url: '/api/requests/rq_doesnotexist', cookies: h.cookieFor(a) });
    expect(res.statusCode).toBe(404);
  });

  it('malformed rq_ param → 400', async () => {
    const a = await insertUser(h.db, { role: 'user', status: 'active' });
    const cookie = h.cookieFor(a);
    for (const bad of ['rq', 'rq_', 'us_abc']) {
      const res = await h.app.inject({ method: 'GET', url: `/api/requests/${bad}`, cookies: cookie });
      expect(res.statusCode, `param "${bad}"`).toBe(400);
    }
  });

  it('falls back to the current user when the requester row is gone (no crash)', async () => {
    const owner = await insertUser(h.db, { role: 'user', status: 'active', username: 'owner' });
    const admin = await insertUser(h.db, { role: 'admin', status: 'active', username: 'admin' });
    const { row } = await h.requests.create(owner.id, bodyFor('B01'));

    // Stub getById to drop ONLY the owner — the auth plugin still resolves the admin caller.
    // (Deleting the owner row would cascade-delete the request, so the state is only
    // reachable via the stub, per schema.ts onDelete: 'cascade'.)
    const original = h.users.getById.bind(h.users);
    vi.spyOn(h.users, 'getById').mockImplementation((id: number) =>
      id === owner.id ? Promise.resolve(undefined) : original(id),
    );

    const res = await h.app.inject({ method: 'GET', url: `/api/requests/${row.publicId}`, cookies: h.cookieFor(admin) });
    expect(res.statusCode).toBe(200);
    // Requester resolution falls back to the authenticated caller (the admin).
    expect(res.json().requester).toEqual({ publicId: admin.publicId, username: 'admin' });
  });
});

// The harness exposes two auth strategies; the cookie path is exercised throughout above.
// This pins the header-shim role override (authz-only, no DB row / cookie) so follow-up
// route tests can lean on it instead of re-rolling the settings.route.test.ts hook.
describe('harness role-override (header shim)', () => {
  it('injects a synthetic request.user by role and gates authz without a DB row or cookie', async () => {
    const owner = await insertUser(h.db, { role: 'user', status: 'active', username: 'owner' });
    const { row } = await h.requests.create(owner.id, bodyFor('B01'));
    const url = `/api/requests/${row.publicId}`;

    // Both synthetic ids must differ from the seeded owner, otherwise an ownership match
    // (`row.userId === user.id`) — not the role override — would explain the 200/403 below.
    expect(h.roleUsers.admin.id).not.toBe(owner.id);
    expect(h.roleUsers.user.id).not.toBe(owner.id);

    // No header, no cookie → unauthenticated.
    expect((await h.app.inject({ method: 'GET', url })).statusCode).toBe(401);
    // Synthetic admin is a NON-owner, so 200 here proves the admin-role ownership bypass;
    // the synthetic (non-owner) user is forbidden.
    expect((await h.app.inject({ method: 'GET', url, headers: h.asRole('admin') })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'GET', url, headers: h.asRole('user') })).statusCode).toBe(403);
  });
});

describe('GET /api/requests — companion-ebook enrichment (issue #147)', () => {
  const COMPANION = { format: 'epub', sizeBytes: 4096 } as const;

  /** Seed an `available` row (admin auto-approve + an `imported` book) and return its book id. */
  async function seedAvailable(user: { id: number }, asin: string): Promise<string> {
    h.narratorr.status = 'imported';
    const { row } = await h.requests.create(user.id, bodyFor(asin));
    expect(row.status).toBe('available');
    return row.narratorrBookId!;
  }

  async function enableEbooks(): Promise<void> {
    h.narratorr.companionEpub = true;
    await h.connectorSettings.update({ ebooksEnabled: true });
  }

  it('populates companionEbook for an available row with a companion, null for one without', async () => {
    const admin = await insertUser(h.db, { role: 'admin', status: 'active' });
    await enableEbooks();
    const withEbook = await seedAvailable(admin, 'B01');
    const without = await seedAvailable(admin, 'B02');
    h.narratorr.companions.set(withEbook, COMPANION);
    h.narratorr.companions.set(without, null);

    const res = await h.app.inject({ method: 'GET', url: '/api/requests', cookies: h.cookieFor(admin) });

    expect(res.statusCode).toBe(200);
    const byAsin = new Map(res.json().data.map((r: { asin: string }) => [r.asin, r]));
    expect(byAsin.get('B01')).toMatchObject({ companionEbook: COMPANION });
    expect(byAsin.get('B02')).toMatchObject({ companionEbook: null });
  });

  it('a book whose companionEbook key is ABSENT (pre-#1961 narratorr) reads as null, not an error', async () => {
    const admin = await insertUser(h.db, { role: 'admin', status: 'active' });
    await enableEbooks();
    await seedAvailable(admin, 'B01'); // id deliberately NOT registered in `companions`

    const res = await h.app.inject({ method: 'GET', url: '/api/requests', cookies: h.cookieFor(admin) });

    expect(res.statusCode).toBe(200);
    expect(res.json().data[0].companionEbook).toBeNull();
  });

  it('returns null for every row — and makes ZERO getBook calls — with the feature OFF', async () => {
    const admin = await insertUser(h.db, { role: 'admin', status: 'active' });
    const bookId = await seedAvailable(admin, 'B01');
    h.narratorr.companions.set(bookId, COMPANION);
    await h.connectorSettings.update({ ebooksEnabled: false });
    h.narratorr.bookCalls.length = 0;

    const res = await h.app.inject({ method: 'GET', url: '/api/requests', cookies: h.cookieFor(admin) });

    expect(res.json().data.every((r: { companionEbook: unknown }) => r.companionEbook === null)).toBe(true);
    expect(h.narratorr.bookCalls).toEqual([]);
  });

  it('caches across the 4s poll — a second list makes no additional getBook call', async () => {
    const admin = await insertUser(h.db, { role: 'admin', status: 'active' });
    await enableEbooks();
    const bookId = await seedAvailable(admin, 'B01');
    h.narratorr.companions.set(bookId, COMPANION);
    const cookie = h.cookieFor(admin);

    await h.app.inject({ method: 'GET', url: '/api/requests', cookies: cookie });
    h.narratorr.bookCalls.length = 0;
    const second = await h.app.inject({ method: 'GET', url: '/api/requests', cookies: cookie });

    expect(second.json().data[0].companionEbook).toEqual(COMPANION);
    expect(h.narratorr.bookCalls).toEqual([]);
  });

  it('leaves the UNENRICHED surfaces at null even when the book HAS a companion', async () => {
    // The response schema is non-strict, so a route-body assertion alone can't catch a mapper
    // that drops or leaks the field — `toDto()` is asserted directly alongside these.
    const admin = await insertUser(h.db, { role: 'admin', status: 'active' });
    await enableEbooks();
    const bookId = await seedAvailable(admin, 'B01');
    h.narratorr.companions.set(bookId, COMPANION);
    const cookie = h.cookieFor(admin);
    const row = (await h.requests.list({ userId: admin.id, limit: 50, offset: 0 })).data[0]!;

    // The enriched list DOES carry it — the contrast that makes the nulls below meaningful.
    const list = await h.app.inject({ method: 'GET', url: '/api/requests', cookies: cookie });
    expect(list.json().data[0].companionEbook).toEqual(COMPANION);

    const detail = await h.app.inject({ method: 'GET', url: `/api/requests/${row.publicId}`, cookies: cookie });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().companionEbook).toBeNull();

    // The mutation response is a direct toDto() caller too. (`available` is not an ACTIVE status,
    // so re-requesting the same asin opens a NEW row — 201, and immediately available again.)
    const created = await post(cookie, bodyFor('B01'));
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ status: 'available', companionEbook: null });
  });

  it('toDto() itself always emits companionEbook: null', async () => {
    const admin = await insertUser(h.db, { role: 'admin', status: 'active' });
    await enableEbooks();
    const bookId = await seedAvailable(admin, 'B01');
    h.narratorr.companions.set(bookId, COMPANION);
    const stored = await h.requests.getByPublicId(
      (await h.requests.list({ userId: admin.id, limit: 50, offset: 0 })).data[0]!.publicId,
    );

    const dto = h.requests.toDto(stored!, { publicId: admin.publicId, username: admin.username });

    expect(dto.companionEbook).toBeNull();
  });
});

function bodyFor(asin: string) {
  return { asin, title: `Title ${asin}` };
}
