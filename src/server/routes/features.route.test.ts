import { describe, it, expect, afterEach, vi } from 'vitest';
import { buildRouteApp, type RouteHarness } from '../test-support/route-harness.js';
import { insertUser } from '../test-support/db.js';
import { registerFeatureRoutes } from './features.js';
import { FEATURES_OFF, featuresDtoSchema } from '../../shared/schemas/features.js';
import type { CreateNotifierBody } from '../../shared/schemas/connectors.js';

// `GET /api/features` (issue #144). The endpoint is polled by every active client and is the SPA's
// only view of derived feature state, so the two properties it must never violate are: it is
// gated on an ACTIVE account, and it can never 5xx (every failure degrades to feature-off).

let h: RouteHarness;
afterEach(async () => {
  await h.app.close();
  vi.restoreAllMocks();
});

const emailNotifier = (from: string): CreateNotifierBody => ({
  name: 'Mail',
  type: 'email',
  events: ['request.created'],
  config: { host: 'smtp.example.com', port: 587, secure: false, from, to: 'admin@ex.com', pass: 'p' },
});

/** Build the app and seed the admin toggle / Kindle sender the test needs. */
async function build(opts: { ebooksEnabled?: boolean; senderFrom?: string; capability?: boolean } = {}) {
  h = await buildRouteApp({ register: registerFeatureRoutes });
  if (opts.capability !== undefined) h.narratorr.companionEpub = opts.capability;
  if (opts.senderFrom !== undefined) {
    const nf = await h.connectorSettings.createNotifier(emailNotifier(opts.senderFrom));
    await h.connectorSettings.update({ kindleSender: { notifierId: nf.id } });
  }
  if (opts.ebooksEnabled !== undefined) await h.connectorSettings.update({ ebooksEnabled: opts.ebooksEnabled });
  return h;
}

/** Seed a user at the given status and call the endpoint as them (a real signed cookie). */
async function getAs(status: 'active' | 'pending' | 'rejected', over: Parameters<typeof insertUser>[1] = {}) {
  const user = await insertUser(h.db, { role: 'user', status, ...over });
  return h.app.inject({ method: 'GET', url: '/api/features', cookies: h.cookieFor(user) });
}

describe('GET /api/features — authorization', () => {
  it('401s an anonymous caller with no body', async () => {
    await build();
    const res = await h.app.inject({ method: 'GET', url: '/api/features' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).not.toHaveProperty('ebooksEnabled');
  });

  it.each([
    ['pending', 'ACCOUNT_PENDING'],
    ['rejected', 'ACCOUNT_REJECTED'],
  ] as const)('403s a %s account with its account-state code and no feature payload', async (status, code) => {
    // Deliberately stronger than "not 200": a 500, a redirect or a plain 401 would all satisfy
    // that, while none of them is the authorization boundary AC17 specifies.
    await build({ ebooksEnabled: true });
    const res = await getAs(status);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe(code);
    for (const key of ['ebooksEnabled', 'kindleDeliveryAvailable', 'kindleSenderEmail']) {
      expect(res.json()).not.toHaveProperty(key);
    }
  });

  it('200s an active account', async () => {
    await build();
    const res = await getAs('active');
    expect(res.statusCode).toBe(200);
    expect(featuresDtoSchema.parse(res.json())).toEqual(FEATURES_OFF);
  });
});

describe('GET /api/features — derivation', () => {
  it('admin toggle off + capability true → all off, and the probe is NEVER called', async () => {
    // The short-circuit: a disabled instance generates zero narratorr traffic.
    await build({ ebooksEnabled: false, capability: true });
    const res = await getAs('active');
    expect(res.json()).toEqual(FEATURES_OFF);
    expect(h.narratorr.capabilityCalls).toBe(0);
  });

  it('toggle on + capability false → all off (the AND gate, from the other side)', async () => {
    await build({ ebooksEnabled: true, capability: false });
    const res = await getAs('active');
    expect(res.json()).toEqual(FEATURES_OFF);
    expect(h.narratorr.capabilityCalls).toBe(1);
  });

  it('toggle on + capability true, no sender selected → enabled but delivery unavailable', async () => {
    await build({ ebooksEnabled: true, capability: true });
    const res = await getAs('active');
    expect(res.json()).toEqual({ ebooksEnabled: true, kindleDeliveryAvailable: false, kindleSenderEmail: null });
  });

  it('toggle on + capability true + an `ok` sender → the confirmed From, delivery available', async () => {
    await build({ ebooksEnabled: true, capability: true, senderFrom: 'bot@ex.com' });
    const res = await getAs('active');
    expect(res.json()).toEqual({
      ebooksEnabled: true,
      kindleDeliveryAvailable: true,
      kindleSenderEmail: 'bot@ex.com',
    });
  });

  it('a faulty sender yields a null address — never a dangling one', async () => {
    // `sender-changed`: the selection was confirmed against `bot@ex.com`, then the notifier's
    // live From was edited. Kindle's allowlist is keyed to the confirmed address, so delivery is
    // NOT available until an admin reconfirms.
    await build({ ebooksEnabled: true, capability: true, senderFrom: 'bot@ex.com' });
    const [nf] = (await h.connectorSettings.getDto()).notifiers;
    await h.connectorSettings.updateNotifier(nf!.id, emailNotifier('new@ex.com'));
    expect((await h.connectorSettings.getDto()).kindleSender?.status).toBe('sender-changed');
    expect((await getAs('active')).json()).toEqual({
      ebooksEnabled: true,
      kindleDeliveryAvailable: false,
      kindleSenderEmail: null,
    });

    // `notifier-missing`: the selected notifier was deleted out from under the selection.
    await h.connectorSettings.deleteNotifier(nf!.id);
    expect((await h.connectorSettings.getDto()).kindleSender?.status).toBe('notifier-missing');
    // Still `ebooksEnabled` — a broken SENDER disables Kindle delivery, not the whole feature
    // (browser download, #147, stays available).
    expect((await getAs('active')).json()).toEqual({
      ebooksEnabled: true,
      kindleDeliveryAvailable: false,
      kindleSenderEmail: null,
    });
  });

  it('never leaks a healthy sender behind a disabled feature (either gate)', async () => {
    // Both halves of the "derive the address before applying the final gate" bug: an `ok` sender
    // exists, but the feature is off — once via the admin toggle, once via the capability.
    await build({ ebooksEnabled: false, capability: true, senderFrom: 'bot@ex.com' });
    expect((await getAs('active')).json()).toEqual(FEATURES_OFF);
    expect(h.narratorr.capabilityCalls).toBe(0);

    await h.connectorSettings.update({ ebooksEnabled: true });
    h.narratorr.companionEpub = false;
    expect((await getAs('active')).json()).toEqual(FEATURES_OFF);
  });
});

describe('GET /api/features — never 5xx', () => {
  it('degrades to the fail-closed payload when the capability probe throws', async () => {
    await build({ ebooksEnabled: true });
    vi.spyOn(h.features, 'ebooksCapability').mockRejectedValue(new Error('boom'));
    const res = await getAs('active');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(FEATURES_OFF);
  });

  it('degrades to the fail-closed payload when the SETTINGS read throws', async () => {
    // AC22 names both sources. An implementation that only wraps the resolver would 500 here.
    await build({ ebooksEnabled: true });
    vi.spyOn(h.connectorSettings, 'getEbookSettings').mockRejectedValue(new Error('db gone'));
    const res = await getAs('active');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(FEATURES_OFF);
  });
});

describe('GET /api/features — instance-level, not per-user', () => {
  it("ignores the caller's own kindle_email (that stays self-scoped on MeDto)", async () => {
    await build({ ebooksEnabled: true, capability: true, senderFrom: 'bot@ex.com' });
    const withAddress = await getAs('active', { kindleEmail: 'me@kindle.com' });
    const without = await getAs('active', { kindleEmail: null });
    expect(withAddress.json()).toEqual(without.json());
    expect(withAddress.json().kindleSenderEmail).toBe('bot@ex.com'); // the OPERATOR's sender
  });

  it('returns byte-identical bodies to two different active users', async () => {
    await build({ ebooksEnabled: true, capability: true, senderFrom: 'bot@ex.com' });
    const a = await getAs('active', { username: 'ann' });
    const b = await getAs('active', { username: 'bob' });
    expect(a.body).toBe(b.body);
  });
});

// The derivation itself (`deriveFeatures`) moved to `services/feature-state.ts` with the shared
// resolver (issue #146 AC5); its unit tests live beside it in `services/feature-state.test.ts`.
