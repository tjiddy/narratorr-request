import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { eq } from 'drizzle-orm';
import { createTestDb } from '../test-support/db.js';
import { users } from '../../db/schema.js';
import type { Db } from '../../db/client.js';
import { UserService } from '../services/user.service.js';
import { SettingsService } from '../services/settings.service.js';
import { RequestService } from '../services/request.service.js';
import { ConnectorSettingsService } from '../services/connector-settings.service.js';
import { SecretCodec, deriveSettingsKey } from '../util/secret-codec.js';
import { errorHandlerPlugin } from '../plugins/error-handler.js';
import { authRateLimitOptions } from '../plugins/rate-limit.js';
import { authPlugin } from '../plugins/auth.js';
import { registerAuthRoutes } from './auth.js';
import { registerRequestRoutes } from './requests.js';
import type { AppConfig } from '../config.js';
import type { AppDeps } from '../services/deps.js';
import type { INarratorrClient } from '../services/narratorr-client.js';
import { buildRouteApp } from '../test-support/route-harness.js';
import { insertUser } from '../test-support/db.js';
import { meDtoSchema, isApprovedUser, USER_ROLES, USER_STATUSES } from '../../shared/schemas/user.js';
import { requireActiveUser } from '../plugins/auth.js';

const SESSION_SECRET = 'auth-route-test-secret';

// narratorr isn't reached in these tests (pending users are blocked before handoff).
const stubNarratorr = {
  searchMetadata: () => Promise.reject(new Error('not used')),
  addBook: () => Promise.reject(new Error('not used')),
  getBook: () => Promise.reject(new Error('not used')),
} as unknown as INarratorrClient;

// A stub OIDC provider entry for exercising the generic OIDC routes without a real IdP.
// `capture`, when supplied, records the URL string the route hands to handleCallback so a
// test can assert the route's reconstruction (config origin + incoming query, never Host).
function fakeOidc(
  profile = { subject: 'oidc-sub-1', username: 'oidcuser', email: null, thumb: null },
  capture?: (url: string) => void,
) {
  const service = {
    buildAuthUrl: () => Promise.resolve('https://idp.example.com/authorize?x=1'),
    handleCallback: (url: string) => {
      capture?.(url);
      return Promise.resolve(profile);
    },
  };
  const config = { id: 'test', label: 'Test', redirectUri: 'http://localhost/api/auth/oidc/test/callback' };
  return new Map([['test', { service, config }]]) as unknown as AppDeps['oidc'];
}

// Captures the notifier dispatch so tests can assert the user.pending heads-up fires
// (or doesn't). Reassigned per buildApp() call; the latest app's spy is the live one.
let notifySpy: ReturnType<typeof vi.fn>;
// The live UserService so tests can spy on it (e.g. to simulate a signup losing the
// unique-constraint race). Reassigned per buildApp().
let usersSvc: UserService;
// The live ConnectorSettingsService so a test can configure an email notifier and assert
// GET /api/me flips `emailNotifyAvailable` true (issue #50). Reassigned per buildApp().
let connectorSvc: ConnectorSettingsService;
// The live test DB so a test can force a legacy at-rest value the write paths can't produce
// (e.g. an empty-string `users.email`, to pin the shared-predicate parity in issue #120).
let dbRef: Db;

async function buildApp(
  opts: { config?: Partial<AppConfig>; oidc?: AppDeps['oidc'] } = {},
): Promise<FastifyInstance> {
  const db = await createTestDb();
  dbRef = db;
  await new SettingsService(db).ensure();
  const users = new UserService(db, {});
  usersSvc = users;
  const requests = new RequestService(db, stubNarratorr, { defaultQuota: { mode: 'limited', limit: 10 }, windowDays: 30, autoApproveRoles: ['admin'] });
  // GET /api/me reads the notifier config to compute `emailNotifyAvailable` (issue #50) — wire a
  // real (empty) connector service so the self-scoped DTO builds without a live SMTP source.
  const connectorSettings = new ConnectorSettingsService(db, new SecretCodec(deriveSettingsKey({ sessionSecret: SESSION_SECRET })));
  connectorSvc = connectorSettings;
  const config = {
    authMode: 'standard',
    sessionSecret: SESSION_SECRET,
    isProd: false,
    corsOrigin: 'http://localhost',
    localAuth: true,
    ...opts.config,
  } as unknown as AppConfig;
  notifySpy = vi.fn().mockResolvedValue(undefined);
  const deps = {
    config,
    db,
    users,
    requests,
    connectorSettings,
    notifier: { notify: notifySpy },
    oidc: opts.oidc ?? new Map(),
  } as unknown as AppDeps;

  const f = Fastify().withTypeProvider<ZodTypeProvider>();
  f.setValidatorCompiler(validatorCompiler);
  f.setSerializerCompiler(serializerCompiler);
  await f.register(cookie, { secret: SESSION_SECRET });
  await f.register(rateLimit, authRateLimitOptions);
  await f.register(errorHandlerPlugin);
  await f.register(authPlugin, deps);
  registerAuthRoutes(f, deps);
  registerRequestRoutes(f, deps);
  await f.ready();
  return f;
}

function sessionCookie(res: { cookies: Array<{ name: string; value: string }> }): Record<string, string> {
  const c = res.cookies.find((x) => x.name === 'nreq_session');
  if (!c) throw new Error('no session cookie set');
  return { nreq_session: c.value };
}

let app: FastifyInstance;
beforeEach(async () => {
  app = await buildApp();
});
afterEach(async () => {
  await app.close();
});

const signup = (a: FastifyInstance, email: string, password = 'password123') =>
  a.inject({ method: 'POST', url: '/api/auth/local/signup', payload: { email, password } });
const login = (a: FastifyInstance, email: string, password: string) =>
  a.inject({ method: 'POST', url: '/api/auth/local/login', payload: { email, password } });

describe('GET /api/auth/providers', () => {
  it('reports local on + no OIDC providers', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/providers' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ local: true, providers: [] });
  });

  it('reports local off when LOCAL_AUTH is disabled (and the local routes 404)', async () => {
    const a = await buildApp({ config: { localAuth: false } });
    expect((await a.inject({ method: 'GET', url: '/api/auth/providers' })).json().local).toBe(false);
    expect((await signup(a, 'nope@example.com')).statusCode).toBe(404); // routes not registered
    await a.close();
  });
});

describe('local signup', () => {
  it('first user becomes admin + active; the next lands pending (email → username + contact)', async () => {
    const firstRes = await signup(app, 'owner@example.com');
    expect(firstRes.statusCode).toBe(200);
    const firstMe = await app.inject({ method: 'GET', url: '/api/me', cookies: sessionCookie(firstRes) });
    // Display username = email local-part; email captured as the contact.
    expect(firstMe.json()).toMatchObject({ username: 'owner', email: 'owner@example.com', role: 'admin', status: 'active' });

    const secondRes = await signup(app, 'guest@example.com');
    const secondMe = await app.inject({ method: 'GET', url: '/api/me', cookies: sessionCookie(secondRes) });
    expect(secondMe.json()).toMatchObject({ username: 'guest', role: 'user', status: 'pending' });
  });

  it('fires a user.pending notification for a pending signup, never for the first-user admin', async () => {
    await signup(app, 'owner@example.com'); // first user → admin + active
    expect(notifySpy).not.toHaveBeenCalled();

    await signup(app, 'guest@example.com'); // → pending
    expect(notifySpy).toHaveBeenCalledTimes(1);
    expect(notifySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'user.pending',
        user: expect.objectContaining({ username: 'guest', authProvider: 'local', email: 'guest@example.com' }),
      }),
    );
    // The `user` object is an EXPLICIT enumeration, not a row spread — pinned as an exact key set so
    // a self-scoped column (e.g. `kindleEmail`, #142) can never ride out to an admin notifier.
    const payload = notifySpy.mock.calls[0]?.[0] as { user: Record<string, unknown> };
    expect(Object.keys(payload.user).sort()).toEqual(['authProvider', 'email', 'publicId', 'username']);
  });

  it('rejects a duplicate email (case-insensitive) with 409', async () => {
    await signup(app, 'Dup@Example.com');
    const dup = await signup(app, 'dup@example.com');
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('EMAIL_TAKEN');
  });

  it('treats a signup that loses the unique-constraint race as EMAIL_TAKEN and mints no session', async () => {
    // Seed a real "winner" row to hand back from the simulated race.
    await signup(app, 'winner@example.com');
    const winner = await usersSvc.findLocalByEmail('winner@example.com');
    expect(winner).toBeDefined();

    // The racer clears the pre-check (its email isn't stored yet) but loses the INSERT,
    // so createLocalUser returns the EXISTING row with created=false. The route must NOT
    // log the racer into the winner's account — it should 409 with no session cookie.
    vi.spyOn(usersSvc, 'createLocalUser').mockResolvedValue({ user: winner!, created: false });

    const res = await signup(app, 'racer@example.com');
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('EMAIL_TAKEN');
    expect(res.cookies.find((c) => c.name === 'nreq_session')).toBeUndefined();
  });

  it('rejects a malformed email / too-short password with 400', async () => {
    expect((await signup(app, 'not-an-email')).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/auth/local/signup', payload: { email: 'ok@example.com', password: 'short' } })).statusCode).toBe(400);
  });
});

describe('GET /api/me — resolved quota shape per mode (F1)', () => {
  // The badge + "out of requests" UX read `me.quota`, so the resolved mode/limit/remaining
  // contract is asserted at the route boundary — a regression in the blocked/unlimited branch of
  // quotaUsage would leave request-create enforcement green while corrupting what /api/me reports.
  const me = (cookies: Record<string, string>) => app.inject({ method: 'GET', url: '/api/me', cookies });

  it('an admin reports unlimited (mode unlimited, limit/remaining null)', async () => {
    const owner = await signup(app, 'owner@example.com'); // first user → admin → unlimited
    const res = await me(sessionCookie(owner));
    expect(res.json().quota).toEqual({ mode: 'unlimited', limit: null, used: 0, remaining: null, windowDays: 30 });
  });

  it('an inherit (non-override) user reports the limited app default', async () => {
    await signup(app, 'owner@example.com'); // claim the admin slot
    const guest = await signup(app, 'guest@example.com'); // role user, inherit → limited 10
    expect((await me(sessionCookie(guest))).json().quota).toEqual({
      mode: 'limited',
      limit: 10,
      used: 0,
      remaining: 10,
      windowDays: 30,
    });
  });

  it('a blocked user reports mode=blocked with limit null / remaining 0 (NOT unlimited or 0/0)', async () => {
    await signup(app, 'owner@example.com'); // claim the admin slot
    const guest = await signup(app, 'guest@example.com');
    const guestCookie = sessionCookie(guest);
    const publicId = (await me(guestCookie)).json().publicId as string;
    await usersSvc.updateUser(publicId, { requestQuota: { mode: 'blocked' } });

    const res = await me(guestCookie);
    expect(res.statusCode).toBe(200);
    expect(res.json().quota).toEqual({ mode: 'blocked', limit: null, used: 0, remaining: 0, windowDays: 30 });
    // The raw per-user override is surfaced too, so the admin UI can seed the mode control.
    expect(res.json().requestQuota).toEqual({ mode: 'blocked' });
  });
});

describe('local login', () => {
  it('verifies the password and is generic on failure', async () => {
    await signup(app, 'todd@example.com', 'hunter2hunter2');
    expect((await login(app, 'todd@example.com', 'hunter2hunter2')).statusCode).toBe(200);
    // Case-insensitive: the email normalizes to the same subject key.
    expect((await login(app, 'TODD@example.com', 'hunter2hunter2')).statusCode).toBe(200);

    const wrong = await login(app, 'todd@example.com', 'wrongpassword');
    expect(wrong.statusCode).toBe(401);
    const missing = await login(app, 'ghost@example.com', 'whatever123');
    expect(missing.statusCode).toBe(401);
    // Same generic message whether the account exists or not (no enumeration).
    expect(wrong.json().error.message).toBe(missing.json().error.message);
  });
});

describe('approval gate', () => {
  it('blocks a pending user from creating a request (403 ACCOUNT_PENDING)', async () => {
    await signup(app, 'owner@example.com'); // first user, admin+active
    const guest = await signup(app, 'guest@example.com'); // pending
    const res = await app.inject({
      method: 'POST',
      url: '/api/requests',
      cookies: sessionCookie(guest),
      payload: { asin: 'B01', title: 'A Book' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('ACCOUNT_PENDING');
  });

  it('lets the active admin create a request through the gate', async () => {
    const owner = await signup(app, 'owner@example.com'); // admin+active, auto-approves
    // Admin auto-approve → handoff to narratorr; our stub rejects, so we only assert the
    // gate let us THROUGH (not a 401/403). A 5xx from the stub handoff is fine here.
    const res = await app.inject({
      method: 'POST',
      url: '/api/requests',
      cookies: sessionCookie(owner),
      payload: { asin: 'B01', title: 'A Book' },
    });
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).not.toBe(403);
  });
});

describe('rate limiting', () => {
  it('returns 429 with the RATE_LIMITED envelope once the signup cap is exceeded', async () => {
    // Cap is 5/min per (ip, email); the 6th attempt for the same key trips it.
    let last;
    for (let i = 0; i < 6; i++) last = await signup(app, 'spammer@example.com');
    expect(last?.statusCode).toBe(429);
    expect(last?.json().error.code).toBe('RATE_LIMITED');
  });
});

describe('generic OIDC routes', () => {
  it('404s an unknown provider on both login and callback', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/auth/oidc/nope/login' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/auth/oidc/nope/callback?code=x&state=y' })).statusCode).toBe(404);
  });

  it('redirects login to the provider and the callback mints a session', async () => {
    const a = await buildApp({ oidc: fakeOidc() });
    const loginRes = await a.inject({ method: 'GET', url: '/api/auth/oidc/test/login' });
    expect(loginRes.statusCode).toBe(302);
    expect(loginRes.headers.location).toContain('idp.example.com');

    const cbRes = await a.inject({ method: 'GET', url: '/api/auth/oidc/test/callback?code=x&state=y' });
    expect(cbRes.statusCode).toBe(302);
    const me = await a.inject({ method: 'GET', url: '/api/me', cookies: sessionCookie(cbRes) });
    // First user via OIDC → admin + active.
    expect(me.json()).toMatchObject({ username: 'oidcuser', authProvider: 'test', role: 'admin', status: 'active' });
    await a.close();
  });

  it('notifies once when a new OIDC user lands pending, and not on their return login', async () => {
    const a = await buildApp({ oidc: fakeOidc() });
    // A local signup claims the first-user admin slot so the OIDC user lands pending.
    await signup(a, 'owner@example.com');
    notifySpy.mockClear();

    // New OIDC identity → pending → exactly one heads-up.
    await a.inject({ method: 'GET', url: '/api/auth/oidc/test/callback?code=x&state=y' });
    expect(notifySpy).toHaveBeenCalledTimes(1);
    expect(notifySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'user.pending',
        user: expect.objectContaining({ username: 'oidcuser', authProvider: 'test' }),
      }),
    );

    // The same identity logging back in is not a new signup → no notification.
    notifySpy.mockClear();
    await a.inject({ method: 'GET', url: '/api/auth/oidc/test/callback?code=x&state=y' });
    expect(notifySpy).not.toHaveBeenCalled();
    await a.close();
  });

  it('hands handleCallback a URL rebuilt from the configured redirectUri + incoming query, ignoring a hostile Host', async () => {
    // Guards the security seam in auth.ts: the callback URL is reconstructed from the CONFIGURED
    // redirectUri origin/path plus only the incoming query — never from the attacker-controllable
    // Host header. Without this assertion a regression to a Host-derived base, or a dropped
    // code/state passthrough, would break every prod OIDC login while the suite stayed green.
    let captured: string | undefined;
    const a = await buildApp({ oidc: fakeOidc(undefined, (url) => { captured = url; }) });

    await a.inject({
      method: 'GET',
      url: '/api/auth/oidc/test/callback?code=x&state=y',
      headers: { host: 'evil.example' }, // hostile base — must NOT leak into the reconstructed URL
    });

    expect(captured).toBeDefined();
    const parsed = new URL(captured!);
    // Base comes from config, not the Host header (AC1).
    expect(parsed.origin).toBe('http://localhost');
    expect(parsed.pathname).toBe('/api/auth/oidc/test/callback');
    expect(parsed.host).not.toBe('evil.example');
    // Incoming code/state pass through (AC2).
    expect(parsed.searchParams.get('code')).toBe('x');
    expect(parsed.searchParams.get('state')).toBe('y');
    // Both halves together: config base + request query (AC3).
    expect(captured).toBe('http://localhost/api/auth/oidc/test/callback?code=x&state=y');
    await a.close();
  });

  it('redirects to login with ?login_error=oidc when the callback fails', async () => {
    const failing = new Map([
      ['test', {
        service: { buildAuthUrl: () => Promise.resolve('x'), handleCallback: () => Promise.reject(new Error('boom')) },
        config: { id: 'test', label: 'Test', redirectUri: 'http://localhost/api/auth/oidc/test/callback' },
      }],
    ]) as unknown as AppDeps['oidc'];
    const a = await buildApp({ oidc: failing });
    const res = await a.inject({ method: 'GET', url: '/api/auth/oidc/test/callback?code=x&state=y' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('login_error=oidc');
    await a.close();
  });
});

describe('requester-notification opt-in — GET + PATCH /api/me (#50)', () => {
  const me = (cookies: Record<string, string>) => app.inject({ method: 'GET', url: '/api/me', cookies });
  const patchMe = (cookies: Record<string, string>, payload: Record<string, unknown>) =>
    app.inject({ method: 'PATCH', url: '/api/me', cookies, payload });

  it('GET exposes notifyOn (default empty) and emailNotifyAvailable (false with no email notifier configured)', async () => {
    const guest = await signup(app, 'guest@example.com');
    const body = (await me(sessionCookie(guest))).json();
    expect(body.notifyOn).toEqual([]);
    // The user has an email (local signup) but no usable email notifier ⇒ delivery unavailable.
    expect(body.emailNotifyAvailable).toBe(false);
  });

  it('PATCH stores the opt-in set and echoes it; GET reflects it', async () => {
    const guest = await signup(app, 'guest@example.com');
    const cookie = sessionCookie(guest);
    const res = await patchMe(cookie, { notifyOn: ['available'] });
    expect(res.statusCode).toBe(200);
    expect(res.json().notifyOn).toEqual(['available']);
    expect((await me(cookie)).json().notifyOn).toEqual(['available']);
  });

  it('stores the set even with no usable email notifier — enable-without-delivery is NOT a 403', async () => {
    const guest = await signup(app, 'guest@example.com');
    const cookie = sessionCookie(guest);
    const res = await patchMe(cookie, { notifyOn: ['available'] });
    expect(res.statusCode).toBe(200); // storage-permissive; delivery gates at send time, not here
    expect(res.json()).toMatchObject({ notifyOn: ['available'], emailNotifyAvailable: false });
  });

  it('stores the set for a user with NO email contact (null users.email) — no 403, emailNotifyAvailable false (F1)', async () => {
    // The default fakeOidc profile carries email: null — a genuine no-contact identity (the OIDC
    // without-email population Design #4 targets). AC6 requires storage-permissive opt-in here: a
    // future gate on `row.email !== null` in the PATCH handler would 403 this user, so pin the
    // null-contact branch that the email-bearing local-signup cases above cannot exercise.
    const a = await buildApp({ oidc: fakeOidc() });
    try {
      const cbRes = await a.inject({ method: 'GET', url: '/api/auth/oidc/test/callback?code=x&state=y' });
      const cookie = sessionCookie(cbRes);
      // Precondition: this caller genuinely has no email contact.
      expect((await a.inject({ method: 'GET', url: '/api/me', cookies: cookie })).json().email).toBeNull();

      const res = await a.inject({ method: 'PATCH', url: '/api/me', cookies: cookie, payload: { notifyOn: ['available'] } });
      expect(res.statusCode).toBe(200); // NOT a 403 — opt-in is stored regardless of contact
      expect(res.json()).toMatchObject({ notifyOn: ['available'], emailNotifyAvailable: false });
      // Persisted: a fresh GET reflects the stored set (the write hit the row, not just the echo).
      expect((await a.inject({ method: 'GET', url: '/api/me', cookies: cookie })).json().notifyOn).toEqual(['available']);
    } finally {
      await a.close();
    }
  });

  it('rejects a value outside NOTIFIABLE_TRANSITIONS with 400', async () => {
    const guest = await signup(app, 'guest@example.com');
    const res = await patchMe(sessionCookie(guest), { notifyOn: ['failed'] });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a stray key (cannot smuggle a role/status change through the self-scoped endpoint)', async () => {
    const guest = await signup(app, 'guest@example.com');
    const res = await patchMe(sessionCookie(guest), { notifyOn: ['available'], role: 'admin' });
    expect(res.statusCode).toBe(400);
  });

  it('mutates ONLY the caller — a second user’s opt-in set is untouched', async () => {
    const owner = await signup(app, 'owner@example.com'); // first user → admin+active
    const guest = await signup(app, 'guest@example.com');
    await patchMe(sessionCookie(guest), { notifyOn: ['available'] });
    expect((await me(sessionCookie(owner))).json().notifyOn).toEqual([]); // owner unchanged
    expect((await me(sessionCookie(guest))).json().notifyOn).toEqual(['available']);
  });

  it('requires authentication (401 unauthenticated)', async () => {
    expect((await app.inject({ method: 'PATCH', url: '/api/me', payload: { notifyOn: [] } })).statusCode).toBe(401);
  });

  it('emailNotifyAvailable is true once the user has an email AND a usable email notifier exists', async () => {
    const guest = await signup(app, 'guest@example.com');
    await connectorSvc.createNotifier({
      name: 'Mail',
      type: 'email',
      events: ['request.created'],
      config: { host: 'smtp.example.com', port: 587, secure: false, user: 'u', pass: 'p', from: 'ops@example.com', to: 'admin@example.com' },
    });
    expect((await me(sessionCookie(guest))).json().emailNotifyAvailable).toBe(true);
  });

  it('issue #120 an empty-string users.email reads as unavailable even with a usable notifier (shared predicate)', async () => {
    const guest = await signup(app, 'guest@example.com');
    await connectorSvc.createNotifier({
      name: 'Mail',
      type: 'email',
      events: ['request.created'],
      config: { host: 'smtp.example.com', port: 587, secure: false, user: 'u', pass: 'p', from: 'ops@example.com', to: 'admin@example.com' },
    });
    // Force a legacy at-rest value the signup/OIDC write paths can't produce: an empty string.
    // The OLD `row.email !== null` gate would have reported this deliverable; `hasDeliverableContact`
    // agrees with the sweep's send gate — both treat '' as no usable contact.
    await dbRef.update(users).set({ email: '' }).where(eq(users.authSubject, 'guest@example.com'));
    expect((await me(sessionCookie(guest))).json().emailNotifyAvailable).toBe(false);
  });
});

describe('account contact email — PATCH /api/me email contract (#131)', () => {
  const me = (cookies: Record<string, string>) => app.inject({ method: 'GET', url: '/api/me', cookies });
  const patchMe = (cookies: Record<string, string>, payload: Record<string, unknown>) =>
    app.inject({ method: 'PATCH', url: '/api/me', cookies, payload });

  it('sets the contact email (happy path) and echoes it; GET reflects it', async () => {
    const guest = await signup(app, 'guest@example.com');
    const cookie = sessionCookie(guest);
    const res = await patchMe(cookie, { email: '  New@Contact.COM ' });
    expect(res.statusCode).toBe(200);
    expect(res.json().email).toBe('new@contact.com'); // normalized by contactEmailSchema
    expect((await me(cookie)).json().email).toBe('new@contact.com');
  });

  it('clears the contact via email: null', async () => {
    const guest = await signup(app, 'guest@example.com');
    const cookie = sessionCookie(guest);
    expect((await me(cookie)).json().email).toBe('guest@example.com'); // signup seeded the contact
    const res = await patchMe(cookie, { email: null });
    expect(res.statusCode).toBe(200);
    expect(res.json().email).toBeNull();
    expect((await me(cookie)).json().email).toBeNull();
  });

  it('rejects an invalid email with 400', async () => {
    const guest = await signup(app, 'guest@example.com');
    expect((await patchMe(sessionCookie(guest), { email: 'not-an-email' })).statusCode).toBe(400);
  });

  it('rejects email "" with 400 (empty string is NOT a clear sentinel)', async () => {
    const guest = await signup(app, 'guest@example.com');
    const res = await patchMe(sessionCookie(guest), { email: '' });
    expect(res.statusCode).toBe(400);
    expect((await me(sessionCookie(guest))).json().email).toBe('guest@example.com'); // unchanged
  });

  it('a notifyOn-only body leaves the contact email untouched (independent fields)', async () => {
    const guest = await signup(app, 'guest@example.com');
    const cookie = sessionCookie(guest);
    const res = await patchMe(cookie, { notifyOn: ['approved'] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ email: 'guest@example.com', notifyOn: ['approved'] });
  });

  it('an email-only body leaves the opt-in set untouched (independent fields)', async () => {
    const guest = await signup(app, 'guest@example.com');
    const cookie = sessionCookie(guest);
    await patchMe(cookie, { notifyOn: ['approved', 'denied'] });
    const res = await patchMe(cookie, { email: 'edited@x.com' });
    expect(res.json()).toMatchObject({ email: 'edited@x.com', notifyOn: ['approved', 'denied'] });
  });

  it('an empty body is a 200 no-op (both fields optional)', async () => {
    const guest = await signup(app, 'guest@example.com');
    const res = await patchMe(sessionCookie(guest), {});
    expect(res.statusCode).toBe(200);
    expect(res.json().email).toBe('guest@example.com');
  });

  it('editing the contact NEVER mutates the login authSubject — the original login still works', async () => {
    const guest = await signup(app, 'todd@example.com');
    const cookie = sessionCookie(guest);
    await patchMe(cookie, { email: 'contact@elsewhere.com' });

    // The login identity (authSubject) is still the signup email, not the new contact.
    const row = await usersSvc.findLocalByEmail('todd@example.com');
    expect(row?.authSubject).toBe('todd@example.com');
    expect(row?.email).toBe('contact@elsewhere.com');
    // And logging in with the ORIGINAL credentials still succeeds.
    const relogin = await app.inject({
      method: 'POST',
      url: '/api/auth/local/login',
      payload: { email: 'todd@example.com', password: 'password123' },
    });
    expect(relogin.statusCode).toBe(200);
  });
});

describe('PATCH /api/me kindleEmail contract (#142)', () => {
  const me = (cookies: Record<string, string>) => app.inject({ method: 'GET', url: '/api/me', cookies });
  const patchMe = (cookies: Record<string, string>, payload: Record<string, unknown>) =>
    app.inject({ method: 'PATCH', url: '/api/me', cookies, payload });

  // A usable email notifier, so `emailNotifyAvailable` is genuinely capable of being true. Without
  // this the harness has NO email source and the flag is false no matter what the row holds — a
  // contamination test on the bare harness would be vacuous.
  const configureEmailNotifier = () =>
    connectorSvc.createNotifier({
      name: 'Mail',
      type: 'email',
      events: ['request.created'],
      config: { host: 'smtp.example.com', port: 587, secure: false, user: 'u', pass: 'p', from: 'ops@example.com', to: 'admin@example.com' },
    });

  it('a fresh user reads kindleEmail: null', async () => {
    const guest = await signup(app, 'guest@example.com');
    expect((await me(sessionCookie(guest))).json().kindleEmail).toBeNull();
  });

  it('sets the Kindle address and echoes it normalized; GET reflects it', async () => {
    const guest = await signup(app, 'guest@example.com');
    const cookie = sessionCookie(guest);
    const res = await patchMe(cookie, { kindleEmail: '  Device@KINDLE.COM ' });
    expect(res.statusCode).toBe(200);
    expect(res.json().kindleEmail).toBe('device@kindle.com'); // normalized by kindleEmailSchema
    expect((await me(cookie)).json().kindleEmail).toBe('device@kindle.com');
  });

  it('clears the Kindle address via kindleEmail: null', async () => {
    const guest = await signup(app, 'guest@example.com');
    const cookie = sessionCookie(guest);
    await patchMe(cookie, { kindleEmail: 'device@kindle.com' });
    const res = await patchMe(cookie, { kindleEmail: null });
    expect(res.statusCode).toBe(200);
    expect(res.json().kindleEmail).toBeNull();
    expect((await me(cookie)).json().kindleEmail).toBeNull();
  });

  it('rejects a non-kindle.com address with 400, without echoing the address back', async () => {
    const guest = await signup(app, 'guest@example.com');
    const rejected = await patchMe(sessionCookie(guest), { kindleEmail: 'private-device@example.com' });
    expect(rejected.statusCode).toBe(400);
    // `redact()` has no email pattern (it scrubs URL-embedded secrets and known secret values), so
    // the guarantee is that the address never reaches a log/error path at all — starting with the
    // rejection message, which is the one place a validation failure could echo the input back.
    expect(rejected.payload).not.toContain('private-device@example.com');
    expect(rejected.payload).not.toContain('private-device');

    expect((await patchMe(sessionCookie(guest), { kindleEmail: 'a@evilkindle.com' })).statusCode).toBe(400);
  });

  it('rejects kindleEmail "" with 400 and leaves the stored value unchanged', async () => {
    const guest = await signup(app, 'guest@example.com');
    const cookie = sessionCookie(guest);
    await patchMe(cookie, { kindleEmail: 'device@kindle.com' });
    const res = await patchMe(cookie, { kindleEmail: '' });
    expect(res.statusCode).toBe(400);
    expect((await me(cookie)).json().kindleEmail).toBe('device@kindle.com'); // unchanged
  });

  it('rejects a stray key alongside kindleEmail (strictness preserved)', async () => {
    const guest = await signup(app, 'guest@example.com');
    const res = await patchMe(sessionCookie(guest), { kindleEmail: 'device@kindle.com', role: 'admin' });
    expect(res.statusCode).toBe(400);
  });

  it('401s unauthenticated', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/me', payload: { kindleEmail: 'a@kindle.com' } });
    expect(res.statusCode).toBe(401);
  });

  // Three-way independence. #131 only proved email ⟂ notifyOn; a third field on the same write
  // path needs every pair re-asserted or a shared UPDATE can clobber a sibling column.
  describe('notifyOn / email / kindleEmail are mutually independent', () => {
    const seedAll = async () => {
      const guest = await signup(app, 'guest@example.com');
      const cookie = sessionCookie(guest);
      await patchMe(cookie, { notifyOn: ['approved'], email: 'contact@x.com', kindleEmail: 'device@kindle.com' });
      return cookie;
    };

    it('a notifyOn-only body leaves email and kindleEmail untouched', async () => {
      const cookie = await seedAll();
      const res = await patchMe(cookie, { notifyOn: ['denied'] });
      expect(res.json()).toMatchObject({
        notifyOn: ['denied'],
        email: 'contact@x.com',
        kindleEmail: 'device@kindle.com',
      });
    });

    it('an email-only body leaves notifyOn and kindleEmail untouched', async () => {
      const cookie = await seedAll();
      const res = await patchMe(cookie, { email: 'edited@x.com' });
      expect(res.json()).toMatchObject({
        notifyOn: ['approved'],
        email: 'edited@x.com',
        kindleEmail: 'device@kindle.com',
      });
    });

    it('a kindleEmail-only body leaves notifyOn and email untouched', async () => {
      const cookie = await seedAll();
      const res = await patchMe(cookie, { kindleEmail: 'other@kindle.com' });
      expect(res.json()).toMatchObject({
        notifyOn: ['approved'],
        email: 'contact@x.com',
        kindleEmail: 'other@kindle.com',
      });
    });

    it('a body carrying all three applies all three; an empty body is a 200 no-op', async () => {
      const cookie = await seedAll();
      const all = await patchMe(cookie, { notifyOn: ['available'], email: 'new@x.com', kindleEmail: 'new@kindle.com' });
      expect(all.json()).toMatchObject({
        notifyOn: ['available'],
        email: 'new@x.com',
        kindleEmail: 'new@kindle.com',
      });
      const noop = await patchMe(cookie, {});
      expect(noop.statusCode).toBe(200);
      expect(noop.json()).toMatchObject({
        notifyOn: ['available'],
        email: 'new@x.com',
        kindleEmail: 'new@kindle.com',
      });
    });

    it('clearing the contact email does not clear the Kindle address', async () => {
      const cookie = await seedAll();
      const res = await patchMe(cookie, { email: null });
      expect(res.json()).toMatchObject({ email: null, kindleEmail: 'device@kindle.com' });
    });
  });

  it('mutates only the caller — a second user keeps kindleEmail null', async () => {
    const alice = sessionCookie(await signup(app, 'alice@example.com'));
    const bob = sessionCookie(await signup(app, 'bob@example.com'));
    await patchMe(bob, { kindleEmail: 'bob@kindle.com' });
    expect((await me(alice)).json().kindleEmail).toBeNull();
    expect((await me(bob)).json().kindleEmail).toBe('bob@kindle.com');
  });

  // Contact-predicate contamination (defect vector 8): `hasDeliverableContact` /
  // `emailNotifyAvailable` must keep reading `users.email` ONLY. These run against a harness with a
  // USABLE email notifier configured, so the flag can genuinely flip — the positive control below
  // proves the setup isn't silently pinning it false.
  describe('a Kindle address never contaminates emailNotifyAvailable', () => {
    it('stays false for a caller with a Kindle address but NO contact email', async () => {
      const guest = await signup(app, 'guest@example.com');
      const cookie = sessionCookie(guest);
      await configureEmailNotifier();
      await patchMe(cookie, { email: null }); // no usable contact on the row
      const res = await patchMe(cookie, { kindleEmail: 'device@kindle.com' });
      expect(res.json()).toMatchObject({ email: null, kindleEmail: 'device@kindle.com', emailNotifyAvailable: false });
      expect((await me(cookie)).json().emailNotifyAvailable).toBe(false);
    });

    it('positive control: a real contact email under the SAME notifier flips it true', async () => {
      const guest = await signup(app, 'guest@example.com');
      const cookie = sessionCookie(guest);
      await configureEmailNotifier();
      await patchMe(cookie, { email: null });
      expect((await me(cookie)).json().emailNotifyAvailable).toBe(false);
      const res = await patchMe(cookie, { email: 'contact@x.com' });
      expect(res.json().emailNotifyAvailable).toBe(true);
    });
  });
});

// AC23 (issue #144): `/api/me` must stay ISOLATED from the companion-ebook capability. It is
// `requireUser` (a pending/rejected account can call it) and it is the SPA bootstrap request —
// `App.tsx` white-screens on a non-401 failure — so it must never make, or wait on, a narratorr
// probe. Driven through the shared harness because that wires a real narratorr holder and a real
// capability resolver, i.e. the state a leaking implementation would reach for.
describe('GET /api/me — isolation from narratorr / feature state (#144)', () => {
  const FEATURE_KEYS = ['ebooksEnabled', 'kindleDeliveryAvailable', 'kindleSenderEmail'];

  /** Every narratorr method rejects — a total upstream outage — while counting probe attempts. */
  function deadNarratorr(): INarratorrClient & { capabilityCalls: number } {
    const down = () => Promise.reject(new Error('narratorr down'));
    const client = {
      capabilityCalls: 0,
      searchMetadata: down,
      addBook: down,
      getBook: down,
      getSystem: down,
      getCapabilities: () => {
        client.capabilityCalls += 1;
        return down();
      },
    };
    return client as unknown as INarratorrClient & { capabilityCalls: number };
  }

  it.each([
    ['a total narratorr outage', () => ({ narratorr: deadNarratorr() })],
    ['an unconfigured narratorr', () => ({ narratorrConfigured: false })],
  ])('returns 200 with an unchanged body under %s', async (_label, build) => {
    const over = build();
    const h = await buildRouteApp({ register: registerAuthRoutes, ...over });
    try {
      // The admin toggle is ON, so a `/api/me` that consulted feature state would probe.
      await h.connectorSettings.update({ ebooksEnabled: true });
      const user = await insertUser(h.db, { role: 'user', status: 'active' });
      const res = await h.app.inject({ method: 'GET', url: '/api/me', cookies: h.cookieFor(user) });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.publicId).toBe(user.publicId);
      for (const key of FEATURE_KEYS) expect(body).not.toHaveProperty(key);
      // …and no probe was attempted on this path at all (the unconfigured case has no client
      // to count on — the holder itself refuses, which the assertion above already covers).
      expect(('narratorr' in over ? over.narratorr : h.narratorr).capabilityCalls).toBe(0);
    } finally {
      await h.app.close();
    }
  });

  it('keeps the feature keys out of the mapper as well as the wire', async () => {
    // `meDtoSchema` is non-`.strict()`, so it silently strips unknown keys — a route-body
    // assertion alone cannot catch a mapper that started emitting them. Assert the schema itself
    // has no such field (learned in #142/#159).
    for (const key of FEATURE_KEYS) {
      expect(meDtoSchema.shape).not.toHaveProperty(key);
    }
  });
});

/**
 * F4 — the approval-queue policy has ONE home (`isApprovedUser`), and the server's authorization
 * boundary is the thing that must actually obey it.
 *
 * `requireActiveUser` (the enforcement), `App.tsx` (which shell an authenticated caller sees) and
 * `featuresQueryEnabled` (whether to issue an active-user-only request) all consume the shared
 * predicate. Each of those has its own unit tests, but per-layer tests can ALL stay green while
 * the layers drift apart — so this asserts the cross-contract directly: over the complete
 * role × status matrix, `requireActiveUser` admits exactly the callers `isApprovedUser` accepts.
 *
 * Driven through the real guard, not a re-derivation of it: if a future change reintroduces a
 * local role/status test in `auth.ts`, this fails even though the predicate itself still passes.
 */
describe('requireActiveUser × isApprovedUser cross-contract (#144 F4)', () => {
  const MATRIX = USER_ROLES.flatMap((role) => USER_STATUSES.map((status) => ({ role, status })));

  it('covers the whole role × status space, with both verdicts represented', () => {
    // Guards the guard: a matrix that accidentally became all-admit (or all-deny) would make
    // every row below vacuous.
    expect(MATRIX).toHaveLength(6);
    const approved = MATRIX.filter(isApprovedUser);
    expect(approved.length).toBeGreaterThan(0);
    expect(approved.length).toBeLessThan(MATRIX.length);
  });

  it.each(MATRIX)('requireActiveUser admits (%s) exactly when isApprovedUser does', (user) => {
    const request = { user: { id: 1, publicId: 'us_1', username: 'u', ...user } } as FastifyRequest;
    const expected = isApprovedUser(user);

    if (expected) {
      expect(requireActiveUser(request)).toMatchObject(user);
    } else {
      // …and a rejected caller gets the account-state error, never a silent pass-through.
      expect(() => requireActiveUser(request)).toThrowError(
        expect.objectContaining({ statusCode: 403 }) as Error,
      );
    }
  });

  it('still rejects an unauthenticated request regardless of the predicate', () => {
    // `isApprovedUser` speaks only to role/status; authentication is a separate precondition the
    // guard owns, and sharing the predicate must not have leaked that away.
    expect(() => requireActiveUser({} as FastifyRequest)).toThrowError(
      expect.objectContaining({ statusCode: 401 }) as Error,
    );
  });
});
