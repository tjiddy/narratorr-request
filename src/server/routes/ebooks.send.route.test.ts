import type { AddressInfo } from 'node:net';
import { request as httpRequest } from 'node:http';
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { FastifyInstance, RouteOptions } from 'fastify';
import { buildRouteApp, type RouteHarness } from '../test-support/route-harness.js';
import { insertUser } from '../test-support/db.js';
import { registerEbookRoutes } from './ebooks.js';
import { registerRoutes } from './index.js';
import { ebookSendResultSchema, EBOOK_SEND_OUTCOMES } from '../../shared/schemas/ebooks.js';
import { kindleSends } from '../../db/schema.js';
import type { AppDeps } from '../services/deps.js';

// `POST /api/ebooks/:bookId/send-to-kindle` (issue #148) over `app.inject()`. This file owns the
// ROUTE surface: guards, the feature gate, id grammar, body admission, the pre-handler parser
// errors and the uniform `200 { outcome }` transport. Streaming and SMTP semantics live in the
// service's own real-socket file.

const GOOD_ID = 'bk_abc123';
const KINDLE = 'reader@kindle.com';
const URL_FOR = (bookId: string) => `/api/ebooks/${bookId}/send-to-kindle`;

let h: RouteHarness;
afterEach(async () => {
  await h?.app.close();
  vi.restoreAllMocks();
});

/** Build the app with the ebook routes and a usable Kindle sender + companion. */
async function build(opts: { ebooksEnabled?: boolean; senderOk?: boolean } = {}): Promise<RouteHarness> {
  h = await buildRouteApp({ register: (app, deps) => registerEbookRoutes(app, deps) });
  h.narratorr.companionEpub = true;
  h.narratorr.companions.set(GOOD_ID, { format: 'epub', sizeBytes: 3 });
  await h.connectorSettings.update({ ebooksEnabled: opts.ebooksEnabled ?? true });
  if (opts.senderOk ?? true) {
    const nf = await h.connectorSettings.createNotifier({
      name: 'Mail',
      type: 'email',
      events: [],
      config: { host: 'smtp.example.com', port: 587, secure: false, user: 'u', pass: 'p', to: 'a@ex.com', from: 'library@example.com' },
    });
    await h.connectorSettings.update({ kindleSender: { notifierId: nf.id } });
  }
  return h;
}

async function activeUser(kindleEmail: string | null = KINDLE) {
  const user = await insertUser(h.db, { role: 'user', status: 'active', kindleEmail });
  return { user, cookies: h.cookieFor(user) };
}

const post = (bookId = GOOD_ID, opts: { cookies?: Record<string, string>; payload?: unknown; headers?: Record<string, string> } = {}) =>
  h.app.inject({
    method: 'POST',
    url: URL_FOR(bookId),
    ...(opts.cookies ? { cookies: opts.cookies } : {}),
    ...(opts.payload !== undefined ? { payload: opts.payload as never } : {}),
    ...(opts.headers ? { headers: opts.headers } : {}),
  });

describe('guards (AC3, AC9, AC10)', () => {
  it('401s an anonymous caller — with NO body, so the guard is what answers, not validation', async () => {
    await build();
    const res = await post();
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
    expect(h.ebookStream.opened).toEqual([]);
    expect(h.kindleTransports.messages).toEqual([]);
  });

  it.each([
    ['pending', 'ACCOUNT_PENDING'],
    ['rejected', 'ACCOUNT_REJECTED'],
  ] as const)('403s a %s account with its own code', async (status, code) => {
    await build();
    const user = await insertUser(h.db, { role: 'user', status, kindleEmail: KINDLE });
    const res = await post(GOOD_ID, { cookies: h.cookieFor(user) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe(code);
    expect(h.kindleTransports.messages).toEqual([]);
  });

  it('403s EBOOKS_DISABLED when the feature is off — the same code the download proxy uses', async () => {
    await build({ ebooksEnabled: false });
    const { cookies } = await activeUser();
    const res = await post(GOOD_ID, { cookies });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('EBOOKS_DISABLED');
    expect(h.narratorr.bookCalls).toEqual([]);
    expect(h.ebookStream.opened).toEqual([]);
  });

  it('answers the guard BEFORE the id grammar — an anonymous bad id is 401, not 404', async () => {
    await build();
    expect((await post('not-a-book-id')).statusCode).toBe(401);
  });

  it('appears on the route-guard manifest surface as GUARDED, with no allowlist edit', async () => {
    // The guardrail greps `handler.toString()` for a guard identifier, so a guard extracted into a
    // helper would silently fail it.
    const routes: RouteOptions[] = [];
    h = await buildRouteApp({
      register: (app: FastifyInstance, deps: AppDeps) => {
        app.addHook('onRoute', (r: RouteOptions) => {
          routes.push(r);
        });
        registerRoutes(app, deps);
      },
    });
    const route = routes.find((r) => r.url === URL_FOR(':bookId') && String(r.method).includes('POST'));
    expect(route, 'the send route must be reachable through the central registry').toBeDefined();
    expect(/require(User|ActiveUser|Admin)\b/.test(String(route?.handler))).toBe(true);
  });

  it('declares NO @fastify/rate-limit config — the per-minute cap lives in the admission service', async () => {
    const routes: RouteOptions[] = [];
    h = await buildRouteApp({
      register: (app: FastifyInstance, deps: AppDeps) => {
        app.addHook('onRoute', (r: RouteOptions) => {
          routes.push(r);
        });
        registerEbookRoutes(app, deps);
      },
    });
    const route = routes.find((r) => r.url === URL_FOR(':bookId'));
    // A second limiter here would disagree with the user-keyed, audit-coordinated one.
    expect((route?.config as { rateLimit?: unknown } | undefined)?.rateLimit).toBeUndefined();
  });
});

describe('id handling — grammar vs existence (AC3 vs AC19)', () => {
  it('404s EBOOK_UNAVAILABLE for a MALFORMED id, with the service never invoked', async () => {
    await build();
    const { cookies } = await activeUser();
    const spy = vi.spyOn(h.kindleSends, 'send');
    const res = await post('not-a-book-id', { cookies });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('EBOOK_UNAVAILABLE');
    expect(spy).not.toHaveBeenCalled();
  });

  it('200 { outcome: unavailable } for a WELL-FORMED id with no companion — never an existence oracle', async () => {
    await build();
    const { cookies } = await activeUser();
    const res = await post('bk_never_heard_of', { cookies });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ outcome: 'unavailable' });
    // The metadata lookup is permitted; the STREAM seam must show zero calls.
    expect(h.narratorr.bookCalls).toEqual(['bk_never_heard_of']);
    expect(h.ebookStream.opened).toEqual([]);
  });
});

describe('body admission (AC6) — and the absence of any recipient input (AC7)', () => {
  it('admits an ABSENT body with no content-type', async () => {
    await build();
    const { cookies } = await activeUser();
    const res = await post(GOOD_ID, { cookies });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ outcome: 'sent' });
  });

  it('admits an EMPTY object', async () => {
    await build();
    const { cookies } = await activeUser();
    expect((await post(GOOD_ID, { cookies, payload: {} })).statusCode).toBe(200);
  });

  it('400s an explicit JSON null — normalizing inside Zod would have wrongly accepted it', async () => {
    await build();
    const { cookies } = await activeUser();
    const res = await h.app.inject({
      method: 'POST',
      url: URL_FOR(GOOD_ID),
      cookies,
      headers: { 'content-type': 'application/json' },
      payload: 'null',
    });
    expect(res.statusCode).toBe(400);
    expect(h.kindleTransports.messages).toEqual([]);
  });

  it.each(['to', 'recipient', 'bcc', 'email'])('400s an extra `%s` key — this is not a mail relay', async (key) => {
    await build();
    const { cookies } = await activeUser();
    const res = await post(GOOD_ID, { cookies, payload: { [key]: 'attacker@example.com' } });
    expect(res.statusCode).toBe(400);
    expect(h.kindleTransports.messages).toEqual([]);
  });

  it('delivers ONLY to the caller’s stored address, whatever the request says', async () => {
    await build();
    const { cookies } = await activeUser();
    await post(GOOD_ID, { cookies, payload: { title: 'Anything' } });
    expect(h.kindleTransports.messages).toHaveLength(1);
    expect(h.kindleTransports.messages[0]?.to).toBe(KINDLE);
  });

  it('lets `title` affect ONLY the attachment filename', async () => {
    await build();
    const { cookies } = await activeUser();
    await post(GOOD_ID, { cookies, payload: { title: 'A Nice Book' } });
    const message = h.kindleTransports.messages[0];
    expect(message?.attachments[0]?.filename).toBe('A Nice Book.epub');
    expect(message?.subject).not.toContain('A Nice Book');
    expect(message?.text).not.toContain('A Nice Book');
    // …and it is never persisted onto the audit row.
    const rows = await h.db.select().from(kindleSends);
    expect(JSON.stringify(rows)).not.toContain('A Nice Book');
  });

  it('keeps an anonymous BODYLESS request on the 401 path (the normalization’s whole purpose)', async () => {
    await build();
    // Fastify 5 passes `null` to the body validator when the body is undefined, so without the
    // preValidation normalization a bare strict object would 400 before the guard ever ran.
    expect((await post(GOOD_ID)).statusCode).toBe(401);
  });

  it('documents the known seam: an anonymous caller posting an EXTRA key gets 400, not 401', async () => {
    await build();
    // Body validation runs before the handler, so this is unavoidable — and discloses nothing.
    expect((await post(GOOD_ID, { payload: { to: 'x@y.com' } })).statusCode).toBe(400);
  });
});

describe('outcomes ride the uniform 200 transport (AC2)', () => {
  it('no_kindle_address when the caller has no stored address', async () => {
    await build();
    const { cookies } = await activeUser(null);
    const res = await post(GOOD_ID, { cookies });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ outcome: 'no_kindle_address' });
  });

  it('no_sender — NOT a 403 — when the feature is on but the operator config is the problem', async () => {
    await build({ senderOk: false });
    const { cookies } = await activeUser();
    const res = await post(GOOD_ID, { cookies });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ outcome: 'no_sender' });
  });

  it.each(EBOOK_SEND_OUTCOMES)('round-trips `%s` as 200 { outcome } parsing against the wire schema', async (outcome) => {
    await build();
    const { cookies } = await activeUser();
    vi.spyOn(h.kindleSends, 'send').mockResolvedValue({ outcome });
    const res = await post(GOOD_ID, { cookies });
    expect(res.statusCode).toBe(200);
    expect(ebookSendResultSchema.parse(res.json())).toEqual({ outcome });
  });

  it('surfaces an operational failure as the standard 500 INTERNAL envelope, with no outcome body', async () => {
    await build();
    const { cookies } = await activeUser();
    vi.spyOn(h.kindleSends, 'send').mockRejectedValue(new Error('settings unreadable'));
    const res = await post(GOOD_ID, { cookies });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: 'INTERNAL', message: 'Internal server error' } });
    expect(res.json().outcome).toBeUndefined();
    expect(res.body).not.toContain('settings unreadable');
  });

  it('surfaces a POST-ADMISSION finalization failure the same way — never a typed outcome', async () => {
    await build();
    const { cookies } = await activeUser();
    const { ApiError } = await import('../util/errors.js');
    vi.spyOn(h.kindleSends, 'send').mockRejectedValue(
      new ApiError(500, 'INTERNAL', 'The Send-to-Kindle attempt could not be finalized.'),
    );
    const res = await post(GOOD_ID, { cookies });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: 'INTERNAL', message: 'Internal server error' } });
    expect(res.body).not.toContain('finalized');
  });
});

describe('pre-handler parser errors, through the PRODUCTION error handler (AC3)', () => {
  it.each([
    ['a zero-length body with application/json', 'application/json', '', 400, 'BAD_REQUEST'],
    ['malformed JSON', 'application/json', '{ not json', 400, 'BAD_REQUEST'],
    // `application/xml` has NO registered parser, so Fastify refuses it outright. (`text/plain`
    // deliberately is not used here: Fastify ships a default parser for it, so that case reaches
    // schema validation and is an ordinary 400 — asserted separately below.)
    ['an unsupported media type', 'application/xml', '<x/>', 415, 'UNSUPPORTED_MEDIA_TYPE'],
  ] as const)('%s → %s', async (_label, contentType, payload, status, code) => {
    await build();
    const { cookies } = await activeUser();
    const res = await h.app.inject({
      method: 'POST',
      url: URL_FOR(GOOD_ID),
      cookies,
      headers: { 'content-type': contentType },
      payload,
    });
    expect(res.statusCode).toBe(status);
    expect(res.json()).toEqual({ error: { code, message: expect.any(String) } });
    // Fastify's own wording never leaks — the handler's no-leak doctrine still holds.
    expect(res.body).not.toContain('Body cannot be empty');
    expect(res.body).not.toContain('not valid JSON but content-type');
    expect(res.body).not.toContain('Unsupported Media Type');
  });

  it('a media type Fastify DOES parse still reaches schema validation — an ordinary 400', async () => {
    await build();
    const { cookies } = await activeUser();
    const res = await h.app.inject({
      method: 'POST',
      url: URL_FOR(GOOD_ID),
      cookies,
      headers: { 'content-type': 'text/plain' },
      payload: 'hello',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BAD_REQUEST');
  });

  it('a body past the body limit → 413 PAYLOAD_TOO_LARGE', async () => {
    h = await buildRouteApp({
      register: (app, deps) => {
        // A tiny per-route body limit makes the case reachable without a megabyte payload.
        app.addHook('onRoute', (r: RouteOptions) => {
          if (r.url === URL_FOR(':bookId')) r.bodyLimit = 16;
        });
        registerEbookRoutes(app, deps);
      },
    });
    const user = await insertUser(h.db, { role: 'user', status: 'active', kindleEmail: KINDLE });
    const res = await h.app.inject({
      method: 'POST',
      url: URL_FOR(GOOD_ID),
      cookies: h.cookieFor(user),
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ title: 'x'.repeat(200) }),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(res.body).not.toContain('Request body is too large');
  });

  it('the DECLARED blast radius: a non-Kindle body route gets the same correction', async () => {
    // Before this clause `POST /api/auth/local/login` answered 500 on malformed JSON. Fixing it in
    // the shared plugin is deliberate and strictly more correct, and it is pinned here rather than
    // discovered at review.
    h = await buildRouteApp({ register: registerRoutes, config: { localAuth: true } });
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/local/login',
      headers: { 'content-type': 'application/json' },
      payload: '{ not json',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BAD_REQUEST');
  });

  it('an UNLISTED FST_ERR_CTP_* code still falls through to 500 (the allowlist is not a prefix match)', async () => {
    h = await buildRouteApp({
      register: (app, deps) => {
        registerEbookRoutes(app, deps);
        app.get('/api/__ctp', async () => {
          throw Object.assign(new Error('parser wiring bug'), {
            code: 'FST_ERR_CTP_INVALID_PARSE_TYPE',
            statusCode: 500,
          });
        });
      },
    });
    const res = await h.app.inject({ method: 'GET', url: '/api/__ctp' });
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe('INTERNAL');
  });
});

describe('a client disconnect does NOT abort an admitted send (AC45)', () => {
  it('runs the attempt to its terminal status so the audit row and the quota stay truthful', async () => {
    await build();
    const user = await insertUser(h.db, { role: 'user', status: 'active', kindleEmail: KINDLE });
    const cookie = h.cookieFor(user);

    // Park the SMTP reply so the disconnect lands AFTER the reservation is durable.
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.kindleTransports.reply = async (message) => {
      await held;
      return { accepted: [message.to], rejected: [] };
    };

    await h.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = h.app.server.address() as AddressInfo;
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: URL_FOR(GOOD_ID),
      headers: { cookie: Object.entries(cookie).map(([k, v]) => `${k}=${v}`).join('; ') },
    });
    req.on('error', () => {});
    req.end();

    // Wait until the reservation is durable, then walk away mid-request.
    for (let i = 0; i < 100 && (await h.db.select().from(kindleSends)).length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect((await h.db.select().from(kindleSends))[0]?.status).toBe('started');
    req.destroy();
    await new Promise((r) => setTimeout(r, 20));

    release();
    // The attempt finalizes exactly once, with a truthful terminal status.
    for (let i = 0; i < 200; i += 1) {
      const rows = await h.db.select().from(kindleSends);
      if (rows[0]?.status !== 'started') break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const rows = await h.db.select().from(kindleSends);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'sent' });
    expect(h.kindleTransports.messages).toHaveLength(1);
  }, 30_000);
});
