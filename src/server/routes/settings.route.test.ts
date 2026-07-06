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

import { eq } from 'drizzle-orm';
import { createTestDb } from '../test-support/db.js';
import { appSettings } from '../../db/schema.js';
import type { Db } from '../../db/client.js';
import type { StoredConnectors } from '../../shared/schemas/connectors.js';
import { SettingsService } from '../services/settings.service.js';
import { ConnectorSettingsService } from '../services/connector-settings.service.js';
import { SecretCodec, deriveSettingsKey } from '../util/secret-codec.js';
import { NarratorrClientHolder } from '../services/narratorr-client-holder.js';
import { Notifier } from '../services/notifications/index.js';
import { errorHandlerPlugin } from '../plugins/error-handler.js';
import { registerSettingsRoutes } from './settings.js';
import type { AppDeps } from '../services/deps.js';
import type { AuthUser } from '../types.js';
import type { CreateNotifierBody } from '../../shared/schemas/connectors.js';

const codec = new SecretCodec(deriveSettingsKey({ sessionSecret: 'route-test' }));
const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

const ADMIN: AuthUser = { id: 1, publicId: 'us_admin', username: 'admin', role: 'admin', status: 'active' };
const USER: AuthUser = { id: 2, publicId: 'us_user', username: 'user', role: 'user', status: 'active' };

let app: FastifyInstance;
let deps: AppDeps;
let db: Db;
let connectorSettings: ConnectorSettingsService;
let narratorr: NarratorrClientHolder;

async function buildApp(): Promise<FastifyInstance> {
  db = await createTestDb();
  await new SettingsService(db).ensure();
  connectorSettings = new ConnectorSettingsService(db, codec);
  narratorr = new NarratorrClientHolder(null);
  deps = {
    connectorSettings,
    narratorr,
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
});

describe('settings routes — narratorr test endpoint (unchanged)', () => {
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
