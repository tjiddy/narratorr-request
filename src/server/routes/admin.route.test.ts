import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildRouteApp, TEST_ROLE_HEADER, type RouteHarness } from '../test-support/route-harness.js';
import { insertUser } from '../test-support/db.js';
import { registerAdminRoutes } from './admin.js';

let h: RouteHarness;
beforeEach(async () => {
  h = await buildRouteApp({ register: registerAdminRoutes, enableTestRoleOverride: true });
});
afterEach(async () => {
  await h.app.close();
  vi.restoreAllMocks();
});

const patchUser = (cookies: Record<string, string>, pid: string, payload: Record<string, unknown>) =>
  h.app.inject({ method: 'PATCH', url: `/api/admin/users/${pid}`, cookies, payload });

const bodyFor = (asin: string) => ({ asin, title: `Title ${asin}` });

// AC1 — SELF_GUARD (admin.ts:71-76): an admin can't change their OWN role/status, but
// other own fields and other users' roles are fine. Service-level updateUser logic is
// already unit-tested; here we pin the route-only guard.
describe('PATCH /api/admin/users/:publicId — self-guard', () => {
  it("rejects changing your OWN role → 400 SELF_GUARD", async () => {
    const admin = await insertUser(h.db, { role: 'admin', status: 'active' });
    const res = await patchUser(h.cookieFor(admin), admin.publicId, { role: 'user' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('SELF_GUARD');
  });

  it("rejects changing your OWN status → 400 SELF_GUARD", async () => {
    const admin = await insertUser(h.db, { role: 'admin', status: 'active' });
    const res = await patchUser(h.cookieFor(admin), admin.publicId, { status: 'rejected' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('SELF_GUARD');
  });

  it('still allows changing your OWN requestQuota / autoApprove → 200', async () => {
    const admin = await insertUser(h.db, { role: 'admin', status: 'active' });
    const cookie = h.cookieFor(admin);
    expect((await patchUser(cookie, admin.publicId, { requestQuota: { mode: 'limited', limit: 7 } })).statusCode).toBe(200);
    expect((await patchUser(cookie, admin.publicId, { autoApprove: true })).statusCode).toBe(200);
  });

  it("allows changing ANOTHER user's role — promote and demote → 200", async () => {
    const admin = await insertUser(h.db, { role: 'admin', status: 'active' });
    const cookie = h.cookieFor(admin);
    const target = await insertUser(h.db, { role: 'user', status: 'active', username: 'target' });
    const otherAdmin = await insertUser(h.db, { role: 'admin', status: 'active', username: 'other' });

    const promote = await patchUser(cookie, target.publicId, { role: 'admin' });
    expect(promote.statusCode).toBe(200);
    expect(promote.json().role).toBe('admin');

    const demote = await patchUser(cookie, otherAdmin.publicId, { role: 'user' });
    expect(demote.statusCode).toBe(200);
    expect(demote.json().role).toBe('user');
  });
});

// AC2 — Authz boundary (requireAdmin, all 5 handlers). Bodies/params are deliberately
// VALID so schema validation passes and the request reaches the handler's requireAdmin
// gate (validation runs before the handler — an invalid body would 400 before authz).
describe('admin routes — authz matrix (requireAdmin on every handler)', () => {
  const routes: Array<{ method: 'GET' | 'POST' | 'PATCH'; url: string; payload?: Record<string, unknown> }> = [
    { method: 'GET', url: '/api/admin/requests' },
    { method: 'POST', url: '/api/admin/requests/rq_nonexistent/decision', payload: { action: 'approve' } },
    { method: 'GET', url: '/api/admin/users' },
    { method: 'PATCH', url: '/api/admin/users/us_nonexistent', payload: { autoApprove: true } },
    { method: 'GET', url: '/api/admin/users/us_nonexistent/requests' },
  ];

  for (const r of routes) {
    const inject = (extra: Record<string, unknown>) =>
      h.app.inject({ method: r.method, url: r.url, ...(r.payload ? { payload: r.payload } : {}), ...extra });

    it(`${r.method} ${r.url} — anon → 401 UNAUTHORIZED`, async () => {
      const res = await inject({});
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('UNAUTHORIZED');
    });

    it(`${r.method} ${r.url} — active non-admin → 403 FORBIDDEN`, async () => {
      const res = await inject({ headers: h.asRole('user') });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('FORBIDDEN');
    });

    it(`${r.method} ${r.url} — admin role passes the gate (not 401/403)`, async () => {
      const res = await inject({ headers: h.asRole('admin') });
      expect([401, 403]).not.toContain(res.statusCode);
    });
  }
});

// The x-test-role header shim is opt-in (BuildRouteAppOpts.enableTestRoleOverride). A harness
// built WITHOUT the opt-in must not install the hook, so the header can't bypass real authz —
// an anonymous request carrying x-test-role: admin still hits the requireAdmin gate as anon.
describe('x-test-role shim is opt-in (absent without enableTestRoleOverride)', () => {
  it('ignores x-test-role when the harness did not opt in → 401 UNAUTHORIZED', async () => {
    const noShim = await buildRouteApp({ register: registerAdminRoutes }); // no enableTestRoleOverride
    try {
      const res = await noShim.app.inject({
        method: 'GET',
        url: '/api/admin/users',
        headers: { [TEST_ROLE_HEADER]: 'admin' },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('UNAUTHORIZED');
    } finally {
      await noShim.app.close();
    }
  });
});

// AC3 — Decision endpoint (admin.ts:35-48 glue + request.service.decide).
describe('POST /api/admin/requests/:publicId/decision', () => {
  const decide = (cookies: Record<string, string>, pid: string, payload: Record<string, unknown>) =>
    h.app.inject({ method: 'POST', url: `/api/admin/requests/${pid}/decision`, cookies, payload });

  it('approve → 200 and status advances (handoff to narratorr)', async () => {
    const admin = await insertUser(h.db, { role: 'admin', status: 'active' });
    const requester = await insertUser(h.db, { role: 'user', status: 'active', username: 'req' });
    const { row } = await h.requests.create(requester.id, bodyFor('B01'));
    expect(row.status).toBe('pending');

    const res = await decide(h.cookieFor(admin), row.publicId, { action: 'approve' });
    expect(res.statusCode).toBe(200);
    // FakeNarratorrClient default status 'searching' → acquiring after handoff.
    expect(res.json().status).toBe('acquiring');
    expect(h.narratorr.added).toEqual(['B01']);
  });

  it('deny → 200 and status is denied (no handoff)', async () => {
    const admin = await insertUser(h.db, { role: 'admin', status: 'active' });
    const requester = await insertUser(h.db, { role: 'user', status: 'active', username: 'req' });
    const { row } = await h.requests.create(requester.id, bodyFor('B01'));

    const res = await decide(h.cookieFor(admin), row.publicId, { action: 'deny' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('denied');
    expect(h.narratorr.added).toEqual([]);
  });

  it('re-deciding an already-decided request → 409 NOT_PENDING', async () => {
    const admin = await insertUser(h.db, { role: 'admin', status: 'active' });
    const requester = await insertUser(h.db, { role: 'user', status: 'active', username: 'req' });
    const { row } = await h.requests.create(requester.id, bodyFor('B01'));
    const cookie = h.cookieFor(admin);

    expect((await decide(cookie, row.publicId, { action: 'deny' })).statusCode).toBe(200);
    const second = await decide(cookie, row.publicId, { action: 'approve' });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('NOT_PENDING');
  });

  it('unknown rq_ publicId → 404', async () => {
    const admin = await insertUser(h.db, { role: 'admin', status: 'active' });
    const res = await decide(h.cookieFor(admin), 'rq_doesnotexist', { action: 'approve' });
    expect(res.statusCode).toBe(404);
  });

  it('invalid action → 400', async () => {
    const admin = await insertUser(h.db, { role: 'admin', status: 'active' });
    const requester = await insertUser(h.db, { role: 'user', status: 'active' });
    const { row } = await h.requests.create(requester.id, bodyFor('B01'));
    const res = await decide(h.cookieFor(admin), row.publicId, { action: 'invalid' });
    expect(res.statusCode).toBe(400);
  });

  it('an unknown key → 400 (.strict body)', async () => {
    const admin = await insertUser(h.db, { role: 'admin', status: 'active' });
    const requester = await insertUser(h.db, { role: 'user', status: 'active' });
    const { row } = await h.requests.create(requester.id, bodyFor('B01'));
    const res = await decide(h.cookieFor(admin), row.publicId, { action: 'approve', bogus: true });
    expect(res.statusCode).toBe(400);
  });

  it('note longer than 500 chars → 400', async () => {
    const admin = await insertUser(h.db, { role: 'admin', status: 'active' });
    const requester = await insertUser(h.db, { role: 'user', status: 'active' });
    const { row } = await h.requests.create(requester.id, bodyFor('B01'));
    const res = await decide(h.cookieFor(admin), row.publicId, { action: 'deny', note: 'x'.repeat(501) });
    expect(res.statusCode).toBe(400);
  });

  // Route glue (admin.ts:41-42): decide() returns a valid row but the post-decision
  // requester lookup misses → notFound('requester not found') → 404. The spy is
  // ID-selective so the admin's own auth lookup (same getById, plugins/auth.ts:62)
  // still resolves; a blanket mock would 401 before the route runs. Do NOT delete the
  // requester row instead — requests.userId is onDelete:'cascade' (schema.ts), so that
  // would cascade-delete the request and 404 at the request lookup, not the route glue.
  it('requester not found after a valid decision → 404 (route glue)', async () => {
    const admin = await insertUser(h.db, { role: 'admin', status: 'active' });
    const requester = await insertUser(h.db, { role: 'user', status: 'active', username: 'req' });
    const { row } = await h.requests.create(requester.id, bodyFor('B01'));

    const original = h.users.getById.bind(h.users);
    vi.spyOn(h.users, 'getById').mockImplementation((id: number) =>
      id === requester.id ? Promise.resolve(undefined) : original(id),
    );

    const res = await decide(h.cookieFor(admin), row.publicId, { action: 'deny' });
    expect(res.statusCode).toBe(404);
  });

  it('concurrent decisions on one pending request — first wins, second → 409', async () => {
    const admin = await insertUser(h.db, { role: 'admin', status: 'active' });
    const requester = await insertUser(h.db, { role: 'user', status: 'active' });
    const { row } = await h.requests.create(requester.id, bodyFor('B01'));
    const cookie = h.cookieFor(admin);

    const [a, b] = await Promise.all([
      decide(cookie, row.publicId, { action: 'deny' }),
      decide(cookie, row.publicId, { action: 'deny' }),
    ]);
    const statuses = [a.statusCode, b.statusCode].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = a.statusCode === 409 ? a : b;
    expect(loser.json().error.code).toBe('NOT_PENDING');
  });
});

// AC4 — credential-leak guard: the serialized user list never carries passwordHash.
describe('GET /api/admin/users — no passwordHash leak', () => {
  it('returns {data,total} and the serialized body contains no passwordHash', async () => {
    const admin = await insertUser(h.db, { role: 'admin', status: 'active' });
    await insertUser(h.db, { role: 'user', status: 'active', passwordHash: 'scrypt$super-secret-hash' });

    const res = await h.app.inject({ method: 'GET', url: '/api/admin/users', cookies: h.cookieFor(admin) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(2);
    expect(body.data).toHaveLength(2);
    expect(body.data.some((u: Record<string, unknown>) => 'passwordHash' in u)).toBe(false);
    // Belt-and-braces: the hash value never appears anywhere in the serialized payload.
    expect(JSON.stringify(body)).not.toContain('passwordHash');
    expect(res.payload).not.toContain('super-secret-hash');
  });

  // Sibling assertion that exercises the DTO mapper directly: the response-body check above
  // passes even if the route serializer were disabled, because toDto already drops passwordHash.
  // Loading the full UserRow (passwordHash set) and asserting toDto() omits the key proves the
  // DTO mapper itself — not just the HTTP serializer — is the credential-leak guard.
  it("toDto() omits passwordHash even when the source UserRow carries one", async () => {
    const seeded = await insertUser(h.db, {
      role: 'user',
      status: 'active',
      passwordHash: 'scrypt$super-secret-hash',
    });
    const row = await h.users.getById(seeded.id);
    expect(row).toBeDefined();
    expect(row?.passwordHash).toBe('scrypt$super-secret-hash'); // the source genuinely has it
    const dto = h.users.toDto(row!);
    expect('passwordHash' in dto).toBe(false);
  });
});

// F2 — the two userDtoSchema-bearing surfaces (GET list + PATCH response) must carry the
// mode-based `requestQuota` union, not the old nullable number. These assert the response BODY
// shape at the route boundary so a regression to the old shape, a dropped `limit` on a limited
// response, or a mis-serialized blocked/unlimited mode can't slip past green status-only checks.
describe('admin user response — requestQuota mode DTO (F2)', () => {
  it('GET /api/admin/users serializes every per-user mode into the union', async () => {
    const admin = await insertUser(h.db, { role: 'admin', status: 'active', username: 'admin' });
    await insertUser(h.db, { role: 'user', status: 'active', username: 'def' }); // inherit (no override)
    await insertUser(h.db, { role: 'user', status: 'active', username: 'cap', requestQuota: { mode: 'limited', limit: 4 } });
    await insertUser(h.db, { role: 'user', status: 'active', username: 'unl', requestQuota: { mode: 'unlimited' } });
    await insertUser(h.db, { role: 'user', status: 'active', username: 'blk', requestQuota: { mode: 'blocked' } });

    const res = await h.app.inject({ method: 'GET', url: '/api/admin/users', cookies: h.cookieFor(admin) });
    expect(res.statusCode).toBe(200);
    const byName: Record<string, { requestQuota: unknown }> = Object.fromEntries(
      res.json().data.map((u: { username: string; requestQuota: unknown }) => [u.username, u]),
    );
    expect(byName.def!.requestQuota).toEqual({ mode: 'inherit' });
    expect(byName.cap!.requestQuota).toEqual({ mode: 'limited', limit: 4 });
    expect(byName.unl!.requestQuota).toEqual({ mode: 'unlimited' });
    expect(byName.blk!.requestQuota).toEqual({ mode: 'blocked' });
    // The old nullable-number shape is fully gone from the wire.
    expect(res.payload).not.toMatch(/"requestQuota":\s*(null|\d)/);
  });

  it('PATCH /api/admin/users/:publicId returns the updated mode in the response body', async () => {
    const admin = await insertUser(h.db, { role: 'admin', status: 'active' });
    const target = await insertUser(h.db, { role: 'user', status: 'active', username: 'target' });
    const cookie = h.cookieFor(admin);

    const limited = await patchUser(cookie, target.publicId, { requestQuota: { mode: 'limited', limit: 6 } });
    expect(limited.statusCode).toBe(200);
    expect(limited.json().requestQuota).toEqual({ mode: 'limited', limit: 6 });

    // Switching to a non-limited mode drops the limit on the response (CHECK-coherent persistence).
    const blocked = await patchUser(cookie, target.publicId, { requestQuota: { mode: 'blocked' } });
    expect(blocked.json().requestQuota).toEqual({ mode: 'blocked' });

    const unlimited = await patchUser(cookie, target.publicId, { requestQuota: { mode: 'unlimited' } });
    expect(unlimited.json().requestQuota).toEqual({ mode: 'unlimited' });

    const inherit = await patchUser(cookie, target.publicId, { requestQuota: { mode: 'inherit' } });
    expect(inherit.json().requestQuota).toEqual({ mode: 'inherit' });
  });
});

// AC5 — a single user's request history.
describe('GET /api/admin/users/:publicId/requests', () => {
  it('scopes results to the target user', async () => {
    const admin = await insertUser(h.db, { role: 'admin', status: 'active' });
    const target = await insertUser(h.db, { role: 'user', status: 'active', username: 'target' });
    const other = await insertUser(h.db, { role: 'user', status: 'active', username: 'other' });
    await h.requests.create(target.id, bodyFor('T1'));
    await h.requests.create(target.id, bodyFor('T2'));
    await h.requests.create(other.id, bodyFor('O1'));

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/admin/users/${target.publicId}/requests`,
      cookies: h.cookieFor(admin),
    });
    expect(res.statusCode).toBe(200);
    const { data, total } = res.json();
    expect(total).toBe(2);
    expect(data).toHaveLength(2);
    expect(
      data.every((r: { requester: { publicId: string } }) => r.requester.publicId === target.publicId),
    ).toBe(true);
  });

  it('unknown user → 404', async () => {
    const admin = await insertUser(h.db, { role: 'admin', status: 'active' });
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/admin/users/us_doesnotexist/requests',
      cookies: h.cookieFor(admin),
    });
    expect(res.statusCode).toBe(404);
  });

  it('malformed us_ param → 400', async () => {
    const admin = await insertUser(h.db, { role: 'admin', status: 'active' });
    const cookie = h.cookieFor(admin);
    for (const bad of ['us', 'us_', 'rq_abc', 'us_bad.id', 'us_$$$']) {
      const res = await h.app.inject({ method: 'GET', url: `/api/admin/users/${bad}/requests`, cookies: cookie });
      expect(res.statusCode, `param "${bad}"`).toBe(400);
    }
  });
});

// AC3 — both admin list routes apply the schema's 50/0 default when limit/offset are
// omitted and pass an explicit limit/offset through to the service. Enumerated per-route
// (not "any route") so a regression in one admin handler can't hide behind the other.
describe('admin list routes — paging default + pass-through', () => {
  it('GET /api/admin/requests: omitted → 50/0 default, explicit limit/offset passed through', async () => {
    const admin = await insertUser(h.db, { role: 'admin', status: 'active' });
    const cookie = h.cookieFor(admin);
    const listSpy = vi.spyOn(h.requests, 'list').mockResolvedValue({ data: [], total: 0 });

    await h.app.inject({ method: 'GET', url: '/api/admin/requests', cookies: cookie });
    expect(listSpy).toHaveBeenLastCalledWith({ limit: 50, offset: 0 });

    await h.app.inject({ method: 'GET', url: '/api/admin/requests?status=approved&limit=10&offset=20', cookies: cookie });
    expect(listSpy).toHaveBeenLastCalledWith({ status: 'approved', limit: 10, offset: 20 });
  });

  it('GET /api/admin/users/:publicId/requests: omitted → 50/0 default, explicit passed through', async () => {
    const admin = await insertUser(h.db, { role: 'admin', status: 'active' });
    const target = await insertUser(h.db, { role: 'user', status: 'active', username: 'target' });
    const cookie = h.cookieFor(admin);
    const url = `/api/admin/users/${target.publicId}/requests`;
    const listSpy = vi.spyOn(h.requests, 'list').mockResolvedValue({ data: [], total: 0 });

    await h.app.inject({ method: 'GET', url, cookies: cookie });
    expect(listSpy).toHaveBeenLastCalledWith({ userId: target.id, limit: 50, offset: 0 });

    await h.app.inject({ method: 'GET', url: `${url}?limit=7&offset=14`, cookies: cookie });
    expect(listSpy).toHaveBeenLastCalledWith({ userId: target.id, limit: 7, offset: 14 });
  });

  it('GET /api/admin/requests: limit=0 → 400 (query schema rejects before the handler)', async () => {
    const admin = await insertUser(h.db, { role: 'admin', status: 'active' });
    const res = await h.app.inject({ method: 'GET', url: '/api/admin/requests?limit=0', cookies: h.cookieFor(admin) });
    expect(res.statusCode).toBe(400);
  });
});
