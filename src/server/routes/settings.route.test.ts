import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';

// Hoisted so the vi.mock factory can reference them (vi.mock is hoisted above imports).
// EmailChannel builds a nodemailer transport in its constructor, so the email notifier
// test path is driven through this stub rather than a real SMTP socket.
const { sendMail, createTransport } = vi.hoisted(() => {
  const sendMail = vi.fn();
  return { sendMail, createTransport: vi.fn((_opts?: unknown) => ({ sendMail })) };
});
vi.mock('nodemailer', () => ({ default: { createTransport } }));

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { createTestDb } from '../test-support/db.js';
import { appSettings } from '../../db/schema.js';
import type { Db } from '../../db/client.js';
import type { StoredConnectors } from '../../shared/schemas/connectors.js';
import { SettingsService } from '../services/settings.service.js';
import { ConnectorSettingsService } from '../services/connector-settings.service.js';
import { SecretCodec, deriveSettingsKey } from '../util/secret-codec.js';
import { NarratorrClientHolder } from '../services/narratorr-client-holder.js';
import { FeatureService } from '../services/feature.service.js';
import { Notifier } from '../services/notifications/index.js';
import { errorHandlerPlugin } from '../plugins/error-handler.js';
import { registerSettingsRoutes } from './settings.js';
import { registerFeatureRoutes } from './features.js';
import type { AppDeps } from '../services/deps.js';
import type { AuthUser } from '../types.js';
import type { CreateNotifierBody } from '../../shared/schemas/connectors.js';
import type { V1Capabilities } from '../../shared/schemas/v1/capabilities.js';

const codec = new SecretCodec(deriveSettingsKey({ sessionSecret: 'route-test' }));
const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

const ADMIN: AuthUser = { id: 1, publicId: 'us_admin', username: 'admin', role: 'admin', status: 'active' };
const USER: AuthUser = { id: 2, publicId: 'us_user', username: 'user', role: 'user', status: 'active' };

let app: FastifyInstance;
let deps: AppDeps;
let db: Db;
let connectorSettings: ConnectorSettingsService;
let narratorr: NarratorrClientHolder;
let features: FeatureService;
let capability: CountingCapabilityClient;

/**
 * The upstream the capability resolver probes (issue #144), counting calls so a test can tell a
 * cache hit from a re-probe. Deliberately handed to `FeatureService` as its CLIENT directly rather
 * than through `narratorr`: `reconfigure()` replaces the holder's inner clients with REAL ones
 * pointed at the saved URL, which would turn every probe here into an actual socket. Bypassing the
 * holder on the client side isolates what these tests are about — whether the connection
 * generation moved — from the network. The resolver's GENERATION still comes from the real holder
 * (issue #145), which is precisely the seam under test.
 */
class CountingCapabilityClient {
  calls = 0;
  enabled = true;
  async getCapabilities(): Promise<V1Capabilities> {
    this.calls += 1;
    return { companionEpub: { enabled: this.enabled } };
  }
}

async function buildApp(): Promise<FastifyInstance> {
  db = await createTestDb();
  await new SettingsService(db).ensure();
  connectorSettings = new ConnectorSettingsService(db, codec);
  narratorr = new NarratorrClientHolder(null);
  capability = new CountingCapabilityClient();
  features = new FeatureService(capability, narratorr);
  deps = {
    connectorSettings,
    narratorr,
    features,
    notifier: new Notifier([], null, silentLog),
    // reconfigure() refreshes the request-quota policy on every connector/notifier save.
    requests: { reconfigureQuota: vi.fn() },
    log: silentLog,
  } as unknown as AppDeps;

  const f = Fastify().withTypeProvider<ZodTypeProvider>();
  f.setValidatorCompiler(validatorCompiler);
  f.setSerializerCompiler(serializerCompiler);
  await f.register(errorHandlerPlugin);
  f.addHook('onRequest', async (req) => {
    const role = req.headers['x-test-role'];
    if (role === 'admin') req.user = ADMIN;
    else if (role === 'user') req.user = USER;
  });
  registerSettingsRoutes(f, deps);
  // Registered alongside so the AC16 tests can observe the generation through the real consumer
  // surface (`/api/features` re-probes vs. serves the cached value), not just the counter.
  registerFeatureRoutes(f, deps);
  await f.ready();
  return f;
}

beforeEach(async () => {
  app = await buildApp();
});
afterEach(async () => {
  await app.close();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const asAdmin = { 'x-test-role': 'admin' };
const asUser = { 'x-test-role': 'user' };
const CONNECTORS_URL = '/api/admin/settings/connectors';
const NOTIFIERS_URL = '/api/admin/settings/notifiers';

/** The #207 network-class Test copy — pinned here so the route cases assert the exact string. */
const UNREACHABLE_COPY = 'Could not reach the destination — check the URL, including whether it redirects.';

const ntfyCreate = (over: Partial<CreateNotifierBody> = {}): CreateNotifierBody => ({
  name: 'Phone',
  type: 'ntfy',
  events: ['request.created'],
  config: { url: 'https://ntfy.sh', topic: 'reqs' },
  ...over,
});
const createNotifier = (payload: Record<string, unknown>, headers = asAdmin) =>
  app.inject({ method: 'POST', url: NOTIFIERS_URL, headers, payload });

describe('settings routes — auth gating', () => {
  it('GET — 401 anon, 403 non-admin, 200 admin', async () => {
    expect((await app.inject({ method: 'GET', url: CONNECTORS_URL })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: CONNECTORS_URL, headers: asUser })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: CONNECTORS_URL, headers: asAdmin })).statusCode).toBe(200);
  });

  it('PUT connectors — 401 anon, 403 non-admin, 200 admin', async () => {
    const put = (headers?: Record<string, string>) => app.inject({ method: 'PUT', url: CONNECTORS_URL, payload: {}, ...(headers && { headers }) });
    expect((await put()).statusCode).toBe(401);
    expect((await put(asUser)).statusCode).toBe(403);
    expect((await put(asAdmin)).statusCode).toBe(200);
  });

  it('POST notifiers — 401 anon, 403 non-admin', async () => {
    expect((await app.inject({ method: 'POST', url: NOTIFIERS_URL, payload: ntfyCreate() })).statusCode).toBe(401);
    expect((await createNotifier(ntfyCreate(), asUser)).statusCode).toBe(403);
  });

  it('PUT/DELETE notifier + notifier test reject a non-admin', async () => {
    expect((await app.inject({ method: 'PUT', url: `${NOTIFIERS_URL}/nf_x`, headers: asUser, payload: ntfyCreate() })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `${NOTIFIERS_URL}/nf_x`, headers: asUser })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `${NOTIFIERS_URL}/test`, headers: asUser, payload: { type: 'ntfy', config: {} } })).statusCode).toBe(403);
  });
});

describe('settings routes — GET/PUT connectors', () => {
  it('GET returns the masked DTO with the notifier list; never the secret value', async () => {
    await connectorSettings.update({ narratorr: { url: 'https://n.example.com:443', apiKey: 'super-secret-key' } });
    await connectorSettings.createNotifier(ntfyCreate({ config: { url: 'https://ntfy.sh', topic: 'reqs', token: 'ntfy-secret' } }));
    const res = await app.inject({ method: 'GET', url: CONNECTORS_URL, headers: asAdmin });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('super-secret-key');
    expect(res.body).not.toContain('ntfy-secret');
    const dto = res.json();
    expect(dto.narratorr).toMatchObject({ hasApiKey: true });
    expect(dto.notifiers[0]).toMatchObject({ type: 'ntfy', config: { hasToken: true } });
  });

  it('PUT persists narratorr, masks the response, rebuilds the live narratorr client', async () => {
    expect(narratorr.configured).toBe(false);
    const res = await app.inject({ method: 'PUT', url: CONNECTORS_URL, headers: asAdmin, payload: { narratorr: { url: 'http://n:3000', apiKey: 'k' } } });
    expect(res.statusCode).toBe(200);
    expect(res.json().narratorr.hasApiKey).toBe(true);
    expect(narratorr.configured).toBe(true);
  });

  it('PUT rejects the old ntfy/email/webhook slots (top-level .strict)', async () => {
    const res = await app.inject({ method: 'PUT', url: CONNECTORS_URL, headers: asAdmin, payload: { ntfy: { url: 'https://ntfy.sh', topic: 't' } } });
    expect(res.statusCode).toBe(400);
  });

  it('GET degrades a malformed stored connectors blob to 200 with notifiers: [] instead of 500ing (#93)', async () => {
    // Seed a blob the envelope schema rejects (notifiers not an array) directly into the DB the
    // harness built — the write path would never persist this, but a corrupt/hand-edited row can.
    // The route boundary (ConnectorSettingsService.getDto → settings GET) must degrade, not 500.
    await db
      .update(appSettings)
      .set({ connectors: { publicUrl: null, narratorr: null, notifiers: 42 } as unknown as StoredConnectors })
      .where(eq(appSettings.id, 1));
    const res = await app.inject({ method: 'GET', url: CONNECTORS_URL, headers: asAdmin });
    expect(res.statusCode).toBe(200);
    const dto = res.json();
    expect(dto.narratorr).toBeNull();
    expect(dto.notifiers).toEqual([]);
  });
});

describe('settings routes — Kindle sender selector (#143)', () => {
  const emailCreate = (from: string, name = 'Mail'): CreateNotifierBody => ({
    name,
    type: 'email',
    events: ['request.created'],
    config: { host: 'smtp.example.com', port: 587, secure: false, user: 'u', pass: 'p', from, to: 'admin@ex.com' },
  });

  const putKindle = (kindleSender: unknown, headers = asAdmin) =>
    app.inject({ method: 'PUT', url: CONNECTORS_URL, headers, payload: { kindleSender } });

  it('GET carries the resolved kindleSender — null when unset, the resolved object once saved', async () => {
    // Non-vacuous against the non-strict response schema: a field the mapper emits but the
    // schema omits is silently stripped, so this would read `undefined` on that regression.
    const before = await app.inject({ method: 'GET', url: CONNECTORS_URL, headers: asAdmin });
    expect(before.json()).toHaveProperty('kindleSender', null);

    const nf = (await createNotifier(emailCreate('Narratorr <Bot@Ex.com>'))).json();
    await putKindle({ notifierId: nf.id });
    const res = await app.inject({ method: 'GET', url: CONNECTORS_URL, headers: asAdmin });
    expect(res.json().kindleSender).toEqual({
      notifierId: nf.id,
      confirmedFrom: 'Bot@Ex.com',
      status: 'ok',
      currentFrom: 'Bot@Ex.com',
    });
  });

  it('PUT persists and ECHOES the freshly resolved value; a non-admin is still 403', async () => {
    const nf = (await createNotifier(emailCreate('bot@ex.com'))).json();
    const res = await putKindle({ notifierId: nf.id });
    expect(res.statusCode).toBe(200);
    expect(res.json().kindleSender).toMatchObject({ notifierId: nf.id, confirmedFrom: 'bot@ex.com', status: 'ok' });
    expect((await connectorSettings.getStored()).kindleSender).toEqual({ notifierId: nf.id, confirmedFrom: 'bot@ex.com' });

    expect((await putKindle({ notifierId: nf.id }, asUser)).statusCode).toBe(403);
  });

  it('an invalid selection returns the standard envelope with a CASE-SPECIFIC message', async () => {
    const res = await putKindle({ notifierId: 'nf_nope' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: {
        code: 'KINDLE_SENDER_INVALID',
        message: 'That notifier no longer exists — pick an email notifier that is still configured.',
      },
    });

    const ntfy = (await createNotifier(ntfyCreate())).json();
    expect((await putKindle({ notifierId: ntfy.id })).json().error.message).toBe(
      'The Kindle sender must be an email (SMTP) notifier.',
    );
  });

  it('rejects a client-supplied confirmedFrom (inner .strict) — the confirmation is never spoofable', async () => {
    const nf = (await createNotifier(emailCreate('bot@ex.com'))).json();
    expect((await putKindle({ notifierId: nf.id, confirmedFrom: 'attacker@evil.com' })).statusCode).toBe(400);
  });

  it('editing the selected notifier’s From → sender-changed; re-PUTting the SAME id reconfirms to ok', async () => {
    const nf = (await createNotifier(emailCreate('bot@ex.com'))).json();
    await putKindle({ notifierId: nf.id });

    await app.inject({ method: 'PUT', url: `${NOTIFIERS_URL}/${nf.id}`, headers: asAdmin, payload: emailCreate('new@ex.com') });
    const changed = await app.inject({ method: 'GET', url: CONNECTORS_URL, headers: asAdmin });
    expect(changed.json().kindleSender).toMatchObject({ status: 'sender-changed', confirmedFrom: 'bot@ex.com', currentFrom: 'new@ex.com' });

    const reconfirm = await putKindle({ notifierId: nf.id });
    expect(reconfirm.json().kindleSender).toMatchObject({ status: 'ok', confirmedFrom: 'new@ex.com' });
  });

  // The server-side half of AC21's no-same-id-Save rule: outside `sender-changed`, re-sending the
  // saved id is a GUARANTEED 400 — which is exactly why the picker never offers it.
  it('a same-id re-PUT after the notifier is deleted is rejected 400 (the UI must never offer it)', async () => {
    const nf = (await createNotifier(emailCreate('bot@ex.com'))).json();
    await putKindle({ notifierId: nf.id });
    await app.inject({ method: 'DELETE', url: `${NOTIFIERS_URL}/${nf.id}`, headers: asAdmin });
    expect((await app.inject({ method: 'GET', url: CONNECTORS_URL, headers: asAdmin })).json().kindleSender).toMatchObject({
      status: 'notifier-missing',
    });

    const res = await putKindle({ notifierId: nf.id });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('KINDLE_SENDER_INVALID');
  });

  it('kindleSender: null clears the selection through the route', async () => {
    const nf = (await createNotifier(emailCreate('bot@ex.com'))).json();
    await putKindle({ notifierId: nf.id });
    expect((await putKindle(null)).json().kindleSender).toBeNull();
    expect((await connectorSettings.getStored()).kindleSender).toBeNull();
  });

  // Regression: the parser gates ONLY the selector — retro-validating the notifier's own `from`
  // would brick every working notifier whose From is a display string.
  it('POST/PUT of an email notifier with an unparseable From still succeeds', async () => {
    const created = await createNotifier(emailCreate('ops team'));
    expect(created.statusCode).toBe(200);
    const edited = await app.inject({
      method: 'PUT',
      url: `${NOTIFIERS_URL}/${created.json().id}`,
      headers: asAdmin,
      payload: emailCreate('a@x.com, b@y.com'),
    });
    expect(edited.statusCode).toBe(200);
  });
});

describe('settings routes — notifier CRUD + live reconfigure', () => {
  it('create persists, returns the masked DTO, and rebuilds the live notifier', async () => {
    expect(deps.notifier.enabled).toBe(false);
    const res = await createNotifier(ntfyCreate({ config: { url: 'https://ntfy.sh', topic: 'reqs', token: 'tok' } }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ type: 'ntfy', name: 'Phone', config: { hasToken: true } });
    expect(res.body).not.toContain('tok');
    expect(deps.notifier.enabled).toBe(true); // reconfigure() rebuilt the dispatcher
  });

  it('create enforces a required secret (webhook url) → 400', async () => {
    const res = await createNotifier({ name: 'D', type: 'webhook', events: ['request.created'], config: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('NOTIFIER_SECRET_REQUIRED');
  });

  it('edit by id keeps the omitted secret; delete removes; both reconfigure', async () => {
    const created = (await createNotifier(ntfyCreate({ config: { url: 'https://ntfy.sh', topic: 'reqs', token: 'tok' } }))).json();
    const edited = await app.inject({
      method: 'PUT',
      url: `${NOTIFIERS_URL}/${created.id}`,
      headers: asAdmin,
      payload: ntfyCreate({ name: 'Renamed', config: { url: 'https://ntfy.sh', topic: 'reqs' } }),
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().name).toBe('Renamed');
    // The token survived omit-to-keep (it's still revealed in the runtime config).
    expect((await connectorSettings.getNotificationsConfig()).notifiers[0]!.config.token).toBe('tok');

    const del = await app.inject({ method: 'DELETE', url: `${NOTIFIERS_URL}/${created.id}`, headers: asAdmin });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ ok: true });
    expect(deps.notifier.enabled).toBe(false);
  });

  it('edit / delete a missing id → 404', async () => {
    expect((await app.inject({ method: 'PUT', url: `${NOTIFIERS_URL}/nf_missing`, headers: asAdmin, payload: ntfyCreate() })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `${NOTIFIERS_URL}/nf_missing`, headers: asAdmin })).statusCode).toBe(404);
  });
});

describe('settings routes — create returns the row by id (not by array index)', () => {
  it('returns the created row even when getDto does NOT place it last (index-based impl would fail)', async () => {
    // Force getDto to surface notifiers in a NON-append order so the just-created row is not at
    // the last index. The old `dto.notifiers[length - 1]` impl would return the wrong row here;
    // matching by `created.id` returns the right one. This is what makes the test non-vacuous
    // against a future reorder/filter in getDto (the contract finding #4 protects).
    const realGetDto = connectorSettings.getDto.bind(connectorSettings);
    vi.spyOn(connectorSettings, 'getDto').mockImplementation(async () => {
      const dto = await realGetDto();
      return { ...dto, notifiers: [...dto.notifiers].reverse() }; // created row moves OFF the last index
    });

    // Seed one notifier first so a second create has a sibling to be reordered against.
    await createNotifier(ntfyCreate({ name: 'First', config: { url: 'https://ntfy.sh', topic: 'a' } }));
    const second = await createNotifier(ntfyCreate({ name: 'Second', config: { url: 'https://ntfy.sh', topic: 'b' } }));
    expect(second.statusCode).toBe(200);
    // Under reversed order the LAST index holds 'First'; only a by-id match returns 'Second'.
    expect(second.json().name).toBe('Second');

    const stored = (await connectorSettings.getStored()).notifiers;
    expect(stored.find((n) => n.id === second.json().id)?.name).toBe('Second');
  });
});

describe('settings routes — bounded notifier write body', () => {
  const NAME_MAX = 100;
  const EVENTS_MAX = 20;
  it('a name at the max length succeeds; one over the max is rejected (4xx)', async () => {
    const atMax = await createNotifier(ntfyCreate({ name: 'x'.repeat(NAME_MAX) }));
    expect(atMax.statusCode).toBe(200);
    const overMax = await createNotifier(ntfyCreate({ name: 'x'.repeat(NAME_MAX + 1) }));
    expect(overMax.statusCode).toBe(400);
  });

  it('an events list at the cap succeeds; one over the cap is rejected (4xx)', async () => {
    // Valid keys repeated to length — the cap bounds array length, not key uniqueness.
    const events = (n: number) => Array.from({ length: n }, () => 'request.created' as const);
    const atMax = await createNotifier(ntfyCreate({ events: events(EVENTS_MAX) }));
    expect(atMax.statusCode).toBe(200);
    const overMax = await createNotifier(ntfyCreate({ events: events(EVENTS_MAX + 1) }));
    expect(overMax.statusCode).toBe(400);
  });
});

describe('settings routes — Test probes do not hold the write mutex', () => {
  it('a stalled notifier probe does not block a concurrent create (lock released before send)', async () => {
    // fetch never resolves → the ntfy probe's send() hangs. With the lock held across send the
    // concurrent create would deadlock behind it; releasing the lock first lets the create land.
    let releaseFetch: (v: Response) => void = () => {};
    const fetchCalled = new Promise<void>((resolveCalled) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(() => {
          resolveCalled(); // the probe has reached send() — its lock section is already over
          return new Promise<Response>((res) => { releaseFetch = res; });
        }),
      );
    });

    const probe = app.inject({
      method: 'POST',
      url: `${NOTIFIERS_URL}/test`,
      headers: asAdmin,
      payload: { type: 'ntfy', config: { url: 'https://ntfy.sh', topic: 'hang' } },
    });

    // Wait until the probe is INSIDE the hung send() before issuing the write. By now the lock is
    // either still held (the regression we guard against → the create below would deadlock) or
    // already released (correct → the create completes). Awaiting first makes the assertion
    // deterministic instead of racing the create against the probe's lock acquisition.
    await fetchCalled;
    const created = await createNotifier(ntfyCreate({ name: 'Concurrent', config: { url: 'https://ntfy.sh', topic: 'c' } }));
    expect(created.statusCode).toBe(200);

    // Cleanup: release the hung probe so the pending request settles before afterEach closes the app.
    releaseFetch(new Response(null, { status: 200 }));
    expect((await probe).statusCode).toBe(200);
  });

  it('a stalled narratorr probe does not block a concurrent write (ping released outside the lock)', async () => {
    // Configure narratorr so the probe builds a real client and reaches ping(); ping() uses the
    // global fetch, which we stall. With the lock held across ping() the concurrent create would
    // deadlock behind it — releasing the lock before ping() lets the write land.
    await connectorSettings.update({ narratorr: { url: 'https://n.example.com:443', apiKey: 'k' } });

    let releaseFetch: (v: Response) => void = () => {};
    const fetchCalled = new Promise<void>((resolveCalled) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(() => {
          resolveCalled(); // the probe is inside ping() → its lock section is already over
          return new Promise<Response>((res) => { releaseFetch = res; });
        }),
      );
    });

    const probe = app.inject({
      method: 'POST',
      url: `${CONNECTORS_URL}/test`,
      headers: asAdmin,
      payload: { channel: 'narratorr', narratorr: { url: 'https://n.example.com:443' } },
    });

    // Wait until the probe is INSIDE the hung ping() before issuing the write — by now the lock is
    // either still held (regression → the create would deadlock) or released (correct → it lands).
    // Awaiting first removes the lock-acquisition race that would otherwise let the create win the
    // lock before the probe and pass regardless of where ping() sits relative to the lock.
    await fetchCalled;
    const created = await createNotifier(ntfyCreate({ name: 'Concurrent', config: { url: 'https://ntfy.sh', topic: 'c' } }));
    expect(created.statusCode).toBe(200);

    // Cleanup: release the hung ping (404 → a clean narratorr "connected" probe) so the pending
    // request settles before afterEach closes the app.
    releaseFetch(new Response('{}', { status: 404 }));
    expect((await probe).statusCode).toBe(200);
  });
});

describe('settings routes — notifier test (always 200)', () => {
  const test = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: `${NOTIFIERS_URL}/test`, headers: asAdmin, payload });

  it('webhook success on a 2xx transport response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    const res = await test({ type: 'webhook', config: { url: 'https://x/hook' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, message: 'Test notification sent.' });
  });

  it('webhook failure surfaces the error message, still 200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 500 })));
    const res = await test({ type: 'webhook', config: { url: 'https://x/hook' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: false, message: 'webhook responded 500' });
  });

  it('email test uses the candidate config and renders the request.created subject', async () => {
    sendMail.mockResolvedValue({ messageId: 'x' });
    const res = await test({ type: 'email', config: { host: 'smtp.example.com', from: 'a@b.c', to: 'd@e.f' }, publicUrl: 'https://app.example.com' });
    expect(res.json()).toMatchObject({ success: true });
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ from: 'a@b.c', to: 'd@e.f', subject: 'New audiobook request' }));
  });

  it('event-aware test: a user.pending event renders the user.pending message, not the request one', async () => {
    sendMail.mockResolvedValue({ messageId: 'x' });
    const res = await test({
      type: 'email',
      config: { host: 'smtp.example.com', from: 'a@b.c', to: 'd@e.f' },
      publicUrl: 'https://app.example.com',
      event: 'user.pending',
    });
    expect(res.json()).toMatchObject({ success: true });
    // Assert on the RENDERED message (subject/text/url), not the email adapter's static link
    // label (which is pre-existing debt — see the spec's Out of Scope).
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: 'New user awaiting approval',
        text: expect.stringContaining('https://app.example.com/users'),
      }),
    );
  });

  it('event-aware test: request.created renders the request sample (today’s behavior preserved)', async () => {
    sendMail.mockResolvedValue({ messageId: 'x' });
    const res = await test({
      type: 'email',
      config: { host: 'smtp.example.com', from: 'a@b.c', to: 'd@e.f' },
      publicUrl: 'https://app.example.com',
      event: 'request.created',
    });
    expect(res.json()).toMatchObject({ success: true });
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: 'New audiobook request',
        text: expect.stringContaining('https://app.example.com/admin'),
      }),
    );
  });

  it('event-aware test: request.failed renders the failed sample (request-shaped, with a reason) (#60)', async () => {
    sendMail.mockResolvedValue({ messageId: 'x' });
    const res = await test({
      type: 'email',
      config: { host: 'smtp.example.com', from: 'a@b.c', to: 'd@e.f' },
      publicUrl: 'https://app.example.com',
      event: 'request.failed',
    });
    expect(res.json()).toMatchObject({ success: true });
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: 'Request failed',
        // The sample carries a reason, rendered into the body, and deep-links to /admin.
        text: expect.stringContaining('This is a test failure reason.'),
      }),
    );
  });

  it('edit-by-id reuses the STORED secret (omit-to-keep) in the probe', async () => {
    const created = (await createNotifier(ntfyCreate({ config: { url: 'https://ntfy.sh', topic: 'reqs', token: 'stored-token' } }))).json();
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await test({ type: 'ntfy', id: created.id, config: { url: 'https://ntfy.sh', topic: 'reqs' } });
    expect(res.json()).toMatchObject({ success: true });
    const headers = (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer stored-token');
  });

  it('a missing required secret on a create-test fails cleanly (still 200), and never persists', async () => {
    const before = await connectorSettings.getStored();
    const res = await test({ type: 'webhook', config: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(false);
    expect(await connectorSettings.getStored()).toEqual(before);
  });

  it('redacts a capability webhook URL embedded in a send error from the Test response (Slack)', async () => {
    // Simulate a network error whose message carries the full webhook URL (the capability
    // secret). The route must pass it through redact() — deleting that call leaks the URL.
    const webhookUrl = 'https://hooks.slack.com/services/T00/B00/ROUTESECRETXYZ';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error(`request to ${webhookUrl} failed: ECONNRESET`)));
    const res = await test({ type: 'slack', config: { webhookUrl } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.message).not.toContain('ROUTESECRETXYZ');
    expect(body.message).not.toContain('T00/B00');
  });

  it('redacts a VALUE-class token (Gotify appToken) in a send error via the candidate secrets', async () => {
    // A bare token is not URL-pattern-shaped, so only `redact(err, candidateSecrets(candidate))`
    // scrubs it — this test is non-vacuous against removing the candidateSecrets argument.
    const appToken = 'gotify-app-token-ROUTESECRET-0987654321';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error(`Gotify auth rejected key=${appToken}`)));
    const res = await test({ type: 'gotify', config: { serverUrl: 'https://gotify.example.com', appToken } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.message).not.toContain(appToken);
  });

  // --- #207: the SEND catch maps the network class to actionable copy (the two tests above
  // now pin the FALLBACK path, which stays `redact(err, candidateSecrets(candidate))`).
  it('a fetch network rejection (TypeError) becomes the redirect-aware copy, not the runtime text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    const res = await test({ type: 'ntfy', config: { url: 'https://ntfy.sh', topic: 'reqs' } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({ success: false, message: UNREACHABLE_COPY });
    expect(body.message).not.toContain('fetch failed');
  });

  it('a fired AbortSignal.timeout (TimeoutError) becomes the timeout copy', async () => {
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(timeout));
    const res = await test({ type: 'ntfy', config: { url: 'https://ntfy.sh', topic: 'reqs' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: false, message: 'The destination did not respond in time.' });
  });

  it('the CANDIDATE-BUILD catch is NOT the send mapper — it keeps redact(err) (AC6)', async () => {
    // Pins the boundary: a config-resolution failure must never be reported as "could not reach
    // the destination". A TypeError is used deliberately — it is exactly what the send mapper
    // remaps, so routing this catch through describeSendFailure() would flip this assertion.
    vi.spyOn(connectorSettings, 'buildCandidateNotifier').mockRejectedValue(new TypeError('candidate resolution exploded'));
    const res = await test({ type: 'ntfy', config: { url: 'https://ntfy.sh', topic: 'reqs' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: false, message: 'candidate resolution exploded' });
  });
});

// A real redirect cannot be produced by an in-process fetch stub — `redirect: 'error'` is only
// meaningful to a real HTTP client over a real socket, so correct and broken code behave
// identically under a stub/MSW (learnings `fetch-redirect-error-invariant`, #199, and
// `msw-cannot-test-body-read-abort`, #95). This is the filed case from #207 end to end: the
// admin's base URL 301s, the send rejects, and the Test envelope must say so actionably.
// This file uses no MSW, so the close/re-arm dance narratorr-client.test.ts needs does not apply.
describe('settings routes — notifier test over a REAL redirecting socket (#207)', () => {
  // Defensive: an earlier describe's stubbed fetch must never bleed in and fake this.
  beforeEach(() => vi.unstubAllGlobals());

  interface RecordingServer {
    baseUrl: string;
    requests: string[];
    close(): Promise<void>;
  }

  async function startRecordingServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<RecordingServer> {
    const requests: string[] = [];
    const s = createServer((req, res) => {
      requests.push(req.url ?? '');
      // A client that walks away mid-response makes the socket error (EPIPE/ECONNRESET) — an
      // unhandled 'error' would take the whole vitest worker down.
      res.on('error', () => {});
      req.on('error', () => {});
      handler(req, res);
    });
    await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', () => resolve()));
    const { port } = s.address() as AddressInfo;
    return {
      baseUrl: `http://127.0.0.1:${port}`,
      requests,
      close: async () => {
        s.closeAllConnections(); // undici pools keep-alive sockets; without this `close` hangs
        await new Promise<void>((resolve) => s.close(() => resolve()));
      },
    };
  }

  it('a 301 from the configured base surfaces the redirect-aware copy (still 200), and never reaches the target', async () => {
    const target = await startRecordingServer((_req, res) => res.writeHead(200).end());
    const redirector = await startRecordingServer((req, res) => {
      res.writeHead(301, { location: `${target.baseUrl}${req.url ?? '/'}` }).end();
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `${NOTIFIERS_URL}/test`,
        headers: asAdmin,
        payload: { type: 'ntfy', config: { url: redirector.baseUrl, topic: 'reqs' } },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.message).toBe(UNREACHABLE_COPY);
      // Vacuity guards — without these the test also passes if nothing was ever sent.
      expect(redirector.requests).toEqual(['/reqs']);
      expect(target.requests).toEqual([]);
      expect(body.message).not.toContain('fetch failed');
    } finally {
      await redirector.close();
      await target.close();
    }
  });
});

describe('settings routes — narratorr test endpoint (unchanged)', () => {
  it('an unreachable narratorr (NarratorrError status 0 / NETWORK) gets the redirect-aware copy (#207 AC8)', async () => {
    // NarratorrClient maps a fetch rejection — including the `redirect: 'error'` one (#171) —
    // into NarratorrError(0, 'NETWORK', …), which is the branch whose copy changed.
    await connectorSettings.update({ narratorr: { url: 'https://n.example.com:443', apiKey: 'k' } });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    const res = await app.inject({ method: 'POST', url: `${CONNECTORS_URL}/test`, headers: asAdmin, payload: { channel: 'narratorr', narratorr: { url: 'https://n.example.com:443' } } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: false, message: 'Could not reach narratorr — check the URL, including whether it redirects.' });
  });

  it('reports not-configured without throwing (always 200)', async () => {
    const res = await app.inject({ method: 'POST', url: `${CONNECTORS_URL}/test`, headers: asAdmin, payload: { channel: 'narratorr', narratorr: { url: 'https://n:3000' } } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: false, message: 'Narratorr is not configured.' });
  });

  it('success — a reachable 404 healthcheck proves URL + key', async () => {
    await connectorSettings.update({ narratorr: { url: 'https://n.example.com:443', apiKey: 'k' } });
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}', { status: 404 }))));
    const res = await app.inject({ method: 'POST', url: `${CONNECTORS_URL}/test`, headers: asAdmin, payload: { channel: 'narratorr', narratorr: { url: 'https://n.example.com:443' } } });
    expect(res.json()).toMatchObject({ success: true });
  });
});

describe('settings routes — write mutex (no clobber on overlapping writes)', () => {
  // Force the read-modify-write windows to overlap: delay every getStored so a second
  // request would read stale state before the first persists — the mutex must serialize
  // them so neither change is lost. (A sequential run wouldn't exercise the mutex.)
  function delayGetStored() {
    const orig = connectorSettings.getStored.bind(connectorSettings);
    vi.spyOn(connectorSettings, 'getStored').mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 15));
      return orig();
    });
  }

  it('two concurrent notifier creates both persist (neither clobbers the other)', async () => {
    delayGetStored();
    await Promise.all([
      createNotifier(ntfyCreate({ name: 'A', config: { url: 'https://ntfy.sh', topic: 'a' } })),
      createNotifier(ntfyCreate({ name: 'B', config: { url: 'https://ntfy.sh', topic: 'b' } })),
    ]);
    const names = (await connectorSettings.getStored()).notifiers.map((n) => n.name).sort();
    expect(names).toEqual(['A', 'B']);
  });

  it('a PUT /connectors overlapping a notifier create — both land on the shared blob', async () => {
    delayGetStored();
    await Promise.all([
      app.inject({ method: 'PUT', url: CONNECTORS_URL, headers: asAdmin, payload: { publicUrl: 'https://app.example.com' } }),
      createNotifier(ntfyCreate({ name: 'A', config: { url: 'https://ntfy.sh', topic: 'a' } })),
    ]);
    const stored = await connectorSettings.getStored();
    expect(stored.publicUrl).toBe('https://app.example.com');
    expect(stored.notifiers).toHaveLength(1);
  });
});

// AC16.7 (#144) / AC17-18 (#145): a narratorr CONNECTION CHANGE must install new clients AND
// retire the cached companion-ebook capability — and nothing else may do either. Since #145 those
// are the SAME event: the holder's generation is the resolver's cache key, so one synchronous
// `deps.narratorr.set(...)` — before `reconfigure()`'s remaining awaits — is the whole mechanism.
// A concurrent `/api/features` read (which deliberately does NOT take the settings write mutex)
// therefore can never observe the new connection paired with the old generation's cache.
describe('settings routes — connection swap on a narratorr change (#144/#145)', () => {
  const FEATURES_URL = '/api/features';
  const emailCreate = (from: string): CreateNotifierBody => ({
    name: 'Mail',
    type: 'email',
    events: ['request.created'],
    config: { host: 'smtp.example.com', port: 587, secure: false, user: 'u', pass: 'p', from, to: 'admin@ex.com' },
  });

  const readFeatures = () => app.inject({ method: 'GET', url: FEATURES_URL, headers: asAdmin });
  const putConnectors = (payload: Record<string, unknown>) =>
    app.inject({ method: 'PUT', url: CONNECTORS_URL, headers: asAdmin, payload });

  /** Turn the feature on and warm the cache, so a later probe means the generation was bumped. */
  async function primeCachedCapability(): Promise<void> {
    await connectorSettings.update({ ebooksEnabled: true });
    expect((await readFeatures()).json().ebooksEnabled).toBe(true);
    expect(capability.calls).toBe(1);
    // A second read inside the TTL is served from cache — the baseline every row below contrasts with.
    await readFeatures();
    expect(capability.calls).toBe(1);
  }

  it('swaps on a PUT carrying narratorr — the next read RE-PROBES instead of serving the cache', async () => {
    await primeCachedCapability();
    expect(narratorr.generation).toBe(0);

    const res = await putConnectors({ narratorr: { url: 'http://n:3000', apiKey: 'k' } });
    expect(res.statusCode).toBe(200);
    expect(narratorr.generation).toBe(1);

    expect((await readFeatures()).json().ebooksEnabled).toBe(true);
    expect(capability.calls).toBe(2); // re-probed, despite being well inside the 60s TTL
  });

  it('rebuilds BOTH clients from ONE read of the saved config, observed with no restart', async () => {
    // AC15/AC18/AC25. `fetch` is stubbed, so this asserts on what each half would put on the wire
    // without opening a socket — the JSON and stream clients must carry the SAME freshly-saved
    // base URL and api key, from a single `getNarratorrConfig()` read.
    const reads = vi.spyOn(connectorSettings, 'getNarratorrConfig');
    const before = narratorr.generation;

    expect((await putConnectors({ narratorr: { url: 'http://new-n:3000', apiKey: 'fresh-key' } })).statusCode).toBe(200);
    expect(narratorr.generation).toBe(before + 1);
    expect(reads).toHaveBeenCalledTimes(1);

    const seen: Array<{ url: string; apiKey: string | null }> = [];
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), apiKey: new Headers(init?.headers).get('x-api-key') });
      return Promise.resolve(new Response(null, { status: 500 }));
    });
    await narratorr.getBook('bk_1').catch(() => {});
    await narratorr.openCompanionEpub('bk_1').catch(() => {});

    expect(seen).toHaveLength(2);
    expect(seen[0]?.url).toBe('http://new-n:3000/api/v1/books/bk_1');
    expect(seen[1]?.url).toBe('http://new-n:3000/api/v1/books/bk_1/companion-epub');
    expect(seen[0]?.apiKey).toBe('fresh-key');
    expect(seen[1]?.apiKey).toBe('fresh-key');
  });

  it('DISCONNECTS on a PUT carrying narratorr: null — clears both clients and retires the cache', async () => {
    // The null arm of the swap ternary. Every other case here saves a connection, so reversing or
    // dropping that arm (leaving the retired server's live clients and its cached capability in
    // place) would keep the whole suite green.
    expect((await putConnectors({ narratorr: { url: 'http://n:3000', apiKey: 'k' } })).statusCode).toBe(200);
    await primeCachedCapability();
    expect(narratorr.configured).toBe(true);
    const before = narratorr.generation;

    expect((await putConnectors({ narratorr: null })).statusCode).toBe(200);

    // Exactly one bump, and the connection is genuinely gone…
    expect(narratorr.generation).toBe(before + 1);
    expect(narratorr.configured).toBe(false);
    await expect(Promise.resolve().then(() => narratorr.getBook('bk_1'))).rejects.toMatchObject({
      statusCode: 502,
      upstreamCode: 'NOT_CONFIGURED',
    });
    await expect(Promise.resolve().then(() => narratorr.openCompanionEpub('bk_1'))).rejects.toMatchObject({
      statusCode: 502,
      upstreamCode: 'NOT_CONFIGURED',
    });
    // …and the disconnected server's cached `true` is unreadable — the read re-probes rather than
    // serving it, well inside the 60s TTL.
    const callsBefore = capability.calls;
    expect((await readFeatures()).json().ebooksEnabled).toBe(true);
    expect(capability.calls).toBe(callsBefore + 1);
  });

  it('swaps ADJACENTLY to the DB write — visible while reconfigure() is still parked', async () => {
    // An ordering-only assertion cannot distinguish an adjacent swap from one deferred past the
    // awaits. So park `reconfigure()` INSIDE itself, right after the swap, and assert the new
    // generation is already observable from a concurrent reader.
    await primeCachedCapability();

    let release!: () => void;
    const parked = new Promise<void>((res) => {
      release = res;
    });
    const real = connectorSettings.getNotificationsConfig.bind(connectorSettings);
    vi.spyOn(connectorSettings, 'getNotificationsConfig').mockImplementation(async () => {
      await parked;
      return real();
    });

    const put = putConnectors({ narratorr: { url: 'http://n:3000', apiKey: 'k' } });
    // Let the PUT run up to the parked await.
    await vi.waitFor(() => expect(narratorr.generation).toBe(1));
    // The holder has already swapped…
    expect(narratorr.configured).toBe(true);
    // …and a concurrent read is ALREADY in the new generation: it re-probes rather than serving
    // the cached `true`. A swap deferred past the awaits would still serve the cache here.
    expect((await readFeatures()).json().ebooksEnabled).toBe(true);
    expect(capability.calls).toBe(2);

    release();
    expect((await put).statusCode).toBe(200);
  });

  it.each([
    ['getNotificationsConfig', 'getNotificationsConfig' as const],
    ['getDefaultQuota', 'getDefaultQuota' as const],
  ])('survives a REJECTING %s tail — the swap already happened', async (_label, method) => {
    // The DB update is already durable when the tail runs. A swap placed after it would be
    // skipped entirely by the rejection, stranding the saved connection behind the previous
    // one's clients and cache — indefinitely, since nothing retries.
    await primeCachedCapability();
    vi.spyOn(connectorSettings, method).mockRejectedValue(new Error('tail exploded'));

    const res = await putConnectors({ narratorr: { url: 'http://n:3000', apiKey: 'k' } });
    expect(res.statusCode).toBe(500);
    expect(narratorr.generation).toBe(1);
    expect(narratorr.configured).toBe(true);

    vi.restoreAllMocks();
    expect((await readFeatures()).json().ebooksEnabled).toBe(true);
    expect(capability.calls).toBe(2); // the new generation, not the stranded old one
  });

  // The F13 regressions: `reconfigure()` runs on EVERY save, so an unconditional swap would
  // discard a valid capability result — and its 15-minute stale budget — on each of these, and
  // would silently replace live client instances for no reason. One row per non-narratorr write
  // path. `generation` is exactly the "no silent rebuild" assertion: `set()` is the holder's only
  // writer and always bumps, so an unchanged generation means the SAME client instances.
  describe('does NOT swap on a save that cannot change the connection', () => {
    it.each([
      ['ebooksEnabled only', () => putConnectors({ ebooksEnabled: true })],
      ['defaultQuota only', () => putConnectors({ defaultQuota: { mode: 'limited', limit: 3, windowDays: 7 } })],
      ['publicUrl only', () => putConnectors({ publicUrl: 'https://app.example.com' })],
    ])('%s', async (_label, save) => {
      await primeCachedCapability();
      const before = narratorr.generation;
      expect((await save()).statusCode).toBe(200);
      expect(narratorr.generation).toBe(before);
      // The cached value — and its stale budget — survives.
      expect((await readFeatures()).json().ebooksEnabled).toBe(true);
      expect(capability.calls).toBe(1);
    });

    it('kindleSender only', async () => {
      await primeCachedCapability();
      const before = narratorr.generation;
      const nf = (await createNotifier(emailCreate('bot@ex.com'))).json();
      // (notifier CREATE also ran reconfigure() — assert across both writes)
      expect((await putConnectors({ kindleSender: { notifierId: nf.id } })).statusCode).toBe(200);
      expect(narratorr.generation).toBe(before);
      expect((await readFeatures()).json().kindleSenderEmail).toBe('bot@ex.com');
      expect(capability.calls).toBe(1);
    });

    it.each([
      ['notifier create', async () => (await createNotifier(ntfyCreate())).statusCode],
      [
        'notifier update',
        async () => {
          const nf = (await createNotifier(ntfyCreate())).json();
          const res = await app.inject({
            method: 'PUT',
            url: `${NOTIFIERS_URL}/${nf.id}`,
            headers: asAdmin,
            payload: ntfyCreate({ name: 'Renamed' }),
          });
          return res.statusCode;
        },
      ],
      [
        'notifier delete',
        async () => {
          const nf = (await createNotifier(ntfyCreate())).json();
          const res = await app.inject({ method: 'DELETE', url: `${NOTIFIERS_URL}/${nf.id}`, headers: asAdmin });
          return res.statusCode;
        },
      ],
    ])('%s', async (_label, save) => {
      await primeCachedCapability();
      const before = narratorr.generation;
      expect(await save()).toBe(200);
      expect(narratorr.generation).toBe(before);
      expect((await readFeatures()).json().ebooksEnabled).toBe(true);
      expect(capability.calls).toBe(1);
    });
  });
});
