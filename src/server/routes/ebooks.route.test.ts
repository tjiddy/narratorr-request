import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import type { FastifyInstance, RouteOptions } from 'fastify';
import { buildRouteApp, type RouteHarness } from '../test-support/route-harness.js';
import { insertUser } from '../test-support/db.js';
import { registerEbookRoutes, proxyContentType } from './ebooks.js';
import { registerFeatureRoutes } from './features.js';
import { registerRoutes } from './index.js';
import { NarratorrError } from '../services/narratorr-client.js';
import { EBOOK_DOWNLOAD_MAX } from '../plugins/rate-limit.js';
import { expectNoLeaks as sweepForLeaks, UPSTREAM_POSIX_PATH } from '../test-support/leak-sentinels.js';
import type { AppConfig } from '../config.js';

// `GET /api/ebooks/:bookId/download` (issue #146) over `app.inject()`. This file owns everything
// the transport does NOT have to be real for: guards, flags, id grammar, headers, the AC21 error
// matrix, the rate limiter and the leak sweep. Truncation, backpressure and caller-disconnect need
// a real socket and live in `ebooks.stream.route.test.ts` (learning `msw-cannot-test-body-read-abort`).

const URL_FOR = (bookId: string, query = '') => `/api/ebooks/${bookId}/download${query}`;
/** A fixed instant for the rate-limit cases — any value works, it just must not advance. */
const FROZEN_NOW = new Date('2026-07-28T12:00:00.000Z');
const GOOD_ID = 'bk_abc123';

let h: RouteHarness;
afterEach(async () => {
  // Optional: not every test builds the shared harness (the no-200-schema receipt only calls
  // `collectRoutes`), so under a `-t` filter `h` can legitimately be unset when this runs.
  await h?.app.close();
  vi.restoreAllMocks();
});

/** Build the app with the download route (plus `/api/features`, which shares the resolver). */
async function build(
  opts: { ebooksEnabled?: boolean; capability?: boolean; config?: Partial<AppConfig> } = {},
): Promise<RouteHarness> {
  h = await buildRouteApp({
    register: (app, deps) => {
      registerEbookRoutes(app, deps);
      registerFeatureRoutes(app, deps);
    },
    ...(opts.config ? { config: opts.config } : {}),
  });
  h.narratorr.companionEpub = opts.capability ?? true;
  await h.connectorSettings.update({ ebooksEnabled: opts.ebooksEnabled ?? true });
  return h;
}

/** Seed a user at `status` and return its cookie header. */
async function cookiesFor(status: 'active' | 'pending' | 'rejected', over: Parameters<typeof insertUser>[1] = {}) {
  const user = await insertUser(h.db, { role: 'user', status, ...over });
  return h.cookieFor(user);
}

/** GET the download route as an active user (the common case). */
async function download(bookId = GOOD_ID, query = '', cookies?: Record<string, string>) {
  return h.app.inject({ method: 'GET', url: URL_FOR(bookId, query), ...(cookies ? { cookies } : {}) });
}

// AC38's leak sentinels and the sweep helper live in `test-support/leak-sentinels.ts`, shared with
// the real-socket file — importing one test file from another would re-run its whole suite.
const expectNoLeaks = (res: { body: string; headers: Record<string, unknown> }, where: string) =>
  sweepForLeaks(res.body, res.headers, where);

describe('GET /api/ebooks/:bookId/download — guards (AC1, AC2)', () => {
  it('401s an anonymous caller and opens NO upstream stream', async () => {
    await build();
    const res = await download();
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
    expect(h.ebookStream.opened).toEqual([]);
    expectNoLeaks(res, 'anonymous 401');
  });

  it.each([
    ['pending', 'ACCOUNT_PENDING'],
    ['rejected', 'ACCOUNT_REJECTED'],
  ] as const)('403s a %s account with its own code and opens NO upstream stream', async (status, code) => {
    await build();
    const res = await download(GOOD_ID, '', await cookiesFor(status));
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe(code);
    expect(h.ebookStream.opened).toEqual([]);
    expectNoLeaks(res, `${status} 403`);
  });

  it('200s an active account', async () => {
    await build();
    expect((await download(GOOD_ID, '', await cookiesFor('active'))).statusCode).toBe(200);
  });

  it('answers the guard BEFORE the id grammar — an anonymous bad id is 401, not 404 (AC9)', async () => {
    await build();
    for (const bookId of ['not-a-book', '']) {
      const res = await download(bookId);
      expect(res.statusCode, `bad id ${JSON.stringify(bookId)}`).toBe(401);
      expect(h.ebookStream.opened).toEqual([]);
    }
  });

  it('is registered on the route-guard manifest surface, not the public allowlist', async () => {
    // The manifest test greps the handler SOURCE; assert the same property locally so a refactor
    // that moves the guard out of the handler fails here too, with a pointed message.
    const routes = await collectRoutes();
    const route = routes.find((r) => r.url === '/api/ebooks/:bookId/download');
    expect(String(route?.handler)).toMatch(/requireActiveUser\b/);
  });
});

describe('guard precedence over throttling (AC37, AC2)', () => {
  it('never lets the limiter pre-empt a refusal, however many requests precede it', async () => {
    await build();
    const pending = await cookiesFor('pending');
    const rejected = await cookiesFor('rejected');
    // Well past the cap (10/min) on each identity: an IP-keyed or unconditional limiter would
    // start answering 429 here, which is exactly the non-determinism AC2 forbids.
    for (let i = 0; i < EBOOK_DOWNLOAD_MAX * 2; i += 1) {
      expect((await download()).statusCode, `anonymous #${i}`).toBe(401);
      expect((await download(GOOD_ID, '', pending)).statusCode, `pending #${i}`).toBe(403);
      expect((await download(GOOD_ID, '', rejected)).statusCode, `rejected #${i}`).toBe(403);
    }
    expect(h.ebookStream.opened).toEqual([]);
  });
});

describe('route registration receipts (AC3, AC4, F11)', () => {
  it('adds no HEAD twin, and a HEAD request never reaches the handler', async () => {
    await build();
    const routes = await collectRoutes();
    const methods = routes.filter((r) => r.url === '/api/ebooks/:bookId/download').flatMap((r) => r.method);
    expect(methods).toEqual(['GET']);

    const res = await h.app.inject({ method: 'HEAD', url: URL_FOR(GOOD_ID), cookies: await cookiesFor('active') });
    expect(res.statusCode).toBe(404);
    expect(h.ebookStream.opened).toEqual([]);
  });

  it('declares NO 200 response schema — the payload is bytes, not a DTO (F11)', async () => {
    const routes = await collectRoutes();
    const route = routes.find((r) => r.url === '/api/ebooks/:bookId/download');
    expect(route).toBeDefined();
    expect(route?.schema?.response).toBeUndefined();
  });
});

describe('central route registry (AC1)', () => {
  // Every other test in this file registers `registerEbookRoutes` DIRECTLY, so none of them notices
  // if the `registerRoutes()` wiring line disappears — production would 404 every download while the
  // suite stayed green. These two drive the real central registrar.
  it('registerRoutes() exposes GET /api/ebooks/:bookId/download', async () => {
    const raw: RouteOptions[] = [];
    h = await buildRouteApp({
      register: (app: FastifyInstance, deps) => {
        app.addHook('onRoute', (r: RouteOptions) => {
          raw.push(r);
        });
        registerRoutes(app, deps);
      },
    });
    const registered = raw.flatMap((r) => (Array.isArray(r.method) ? r.method : [r.method]).map((m) => `${m} ${r.url}`));
    expect(registered).toContain('GET /api/ebooks/:bookId/download');
  });

  it('is REACHABLE through the central registry — a miss would be NOT_FOUND, not UNAUTHORIZED', async () => {
    // The behavioral half, and the sharper discriminator: with the route wired, an anonymous caller
    // reaches the handler's guard and gets 401 UNAUTHORIZED. Unwire it and the harness's production
    // not-found handler answers 404 NOT_FOUND instead.
    h = await buildRouteApp({ register: registerRoutes });
    const res = await h.app.inject({ method: 'GET', url: URL_FOR(GOOD_ID) });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
  });
});

describe('feature gating, server-side and fail-closed (AC5-AC8)', () => {
  it.each([
    ['the admin toggle is off', { ebooksEnabled: false, capability: true }],
    ['narratorr does not advertise the capability', { ebooksEnabled: true, capability: false }],
  ])('403s EBOOKS_DISABLED with zero upstream opens when %s', async (_label, opts) => {
    await build(opts);
    const res = await download(GOOD_ID, '', await cookiesFor('active'));
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('EBOOKS_DISABLED');
    expect(h.ebookStream.opened).toEqual([]);
    expectNoLeaks(res, 'flag-off 403');
  });

  it('degrades to 403 EBOOKS_DISABLED (never a 5xx) when the settings read throws (AC7)', async () => {
    await build();
    vi.spyOn(h.connectorSettings, 'getEbookSettings').mockRejectedValue(new Error('db gone'));
    const res = await download(GOOD_ID, '', await cookiesFor('active'));
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('EBOOKS_DISABLED');
    expect(h.ebookStream.opened).toEqual([]);
  });

  it('agrees with /api/features on a STALE cached `true` (AC5, AC7)', async () => {
    // The whole point of one resolver: inside FeatureService's 15-minute stale window a cached
    // `true` still permits the download AND is still reported to the SPA. If enforcement
    // re-decided the probe, these two would disagree — the drift AC5 exists to prevent.
    await build({ capability: true });
    const cookies = await cookiesFor('active');
    expect((await download(GOOD_ID, '', cookies)).statusCode).toBe(200);

    // Probe now fails; the cached value is served stale by FeatureService, unchanged by us.
    vi.spyOn(h.narratorr, 'getCapabilities').mockRejectedValue(new NarratorrError(500, 'HTTP_500', 'upstream down'));
    vi.spyOn(h.features, 'ebooksCapability').mockResolvedValue(true);

    const both = await Promise.all([
      download(GOOD_ID, '', cookies),
      h.app.inject({ method: 'GET', url: '/api/features', cookies }),
    ]);
    expect(both[0].statusCode).toBe(200);
    expect(both[1].json().ebooksEnabled).toBe(true);
  });

  it('opens EXACTLY ONE companion-epub stream per successful download (AC8)', async () => {
    await build();
    await download(GOOD_ID, '', await cookiesFor('active'));
    expect(h.ebookStream.opened).toEqual([GOOD_ID]);
  });
});

describe('bookId grammar (AC9)', () => {
  it.each([
    ['bk_a', 'the shortest legal token'],
    [`bk_${'a'.repeat(61)}`, 'exactly 64 characters, the upper boundary'],
    ['bk_A-B_c', 'base64url alphabet: - and _ are routine'],
  ])('accepts %s (%s)', async (bookId) => {
    await build();
    const res = await download(bookId, '', await cookiesFor('active'));
    expect(res.statusCode).toBe(200);
    expect(h.ebookStream.opened).toEqual([bookId]);
  });

  it.each([
    ['bk_', 'empty token'],
    [`bk_${'a'.repeat(62)}`, 'one character over the 64-char bound'],
    ['not-a-book', 'no bk_ prefix'],
    ['x', 'too short'],
    ['_', 'prefix fragment'],
    ['admin', 'a word, not an id'],
    ['bk_a$b', 'outside the base64url alphabet'],
    ['..%2Fetc%2Fpasswd', 'a percent-encoded traversal that DOES route here'],
    ['%20', 'a percent-encoded space'],
  ])('404s EBOOK_UNAVAILABLE for %s (%s), with no upstream open', async (bookId) => {
    await build();
    const res = await download(bookId, '', await cookiesFor('active'));
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('EBOOK_UNAVAILABLE');
    expect(h.ebookStream.opened).toEqual([]);
    expectNoLeaks(res, `invalid id ${bookId}`);
  });

  it('404s the EMPTY segment, which really does bind bookId === "" and reach the handler', async () => {
    await build();
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/ebooks//download',
      cookies: await cookiesFor('active'),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('EBOOK_UNAVAILABLE');
    expect(h.ebookStream.opened).toEqual([]);
  });
});

describe('framework-refused shapes: containment, not enumeration (AC35)', () => {
  // These never reach the handler, so the property under test is "content-free and no upstream
  // call" — deliberately NOT an `EBOOK_UNAVAILABLE` envelope, and deliberately not exhaustive.
  const routerMisses = [['an unencoded slash inside the segment', '/api/ebooks/a/b/download']] as const;
  const badUrls = [
    ['a bare percent', '/api/ebooks/%/download'],
    ['a malformed escape', '/api/ebooks/%ZZ/download'],
  ] as const;

  it.each(routerMisses)('answers OUR NOT_FOUND envelope for %s', async (_label, url) => {
    await build();
    for (const cookies of [undefined, await cookiesFor('active')]) {
      const res = await h.app.inject({ method: 'GET', url, ...(cookies ? { cookies } : {}) });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('NOT_FOUND');
      expect(h.ebookStream.opened).toEqual([]);
      expectNoLeaks(res, `router miss ${url}`);
    }
  });

  it.each(badUrls)('leaves Fastify FST_ERR_BAD_URL alone for %s (a documented non-envelope)', async (_label, url) => {
    await build();
    for (const cookies of [undefined, await cookiesFor('active')]) {
      const res = await h.app.inject({ method: 'GET', url, ...(cookies ? { cookies } : {}) });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('FST_ERR_BAD_URL');
      expect(h.ebookStream.opened).toEqual([]);
      expectNoLeaks(res, `bad url ${url}`);
    }
  });

  it('leaves Fastify FST_ERR_MAX_PARAM_LENGTH alone for a segment past maxParamLength (100) — the other documented non-envelope', async () => {
    // Since fastify 5.11 / find-my-way 9.7 an over-long param is refused BEFORE routing as an
    // explicit 414 (it used to fall through to our 404 envelope). Like FST_ERR_BAD_URL, the body
    // interpolates only the caller's own URL — content-free, no upstream call.
    await build();
    const url = `/api/ebooks/${'a'.repeat(101)}/download`;
    for (const cookies of [undefined, await cookiesFor('active')]) {
      const res = await h.app.inject({ method: 'GET', url, ...(cookies ? { cookies } : {}) });
      expect(res.statusCode).toBe(414);
      expect(res.json().code).toBe('FST_ERR_MAX_PARAM_LENGTH');
      expect(h.ebookStream.opened).toEqual([]);
      expectNoLeaks(res, `over-long param ${url}`);
    }
  });

  it('a 100-character segment DOES reach the handler — the grammar bound sits below maxParamLength', async () => {
    // The control that makes AC35 half (a) structural rather than coincidental: our 64-char bound
    // is strictly below Fastify's default 100, so nothing the grammar accepts is router-refused.
    await build();
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/ebooks/${'a'.repeat(100)}/download`,
      cookies: await cookiesFor('active'),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('EBOOK_UNAVAILABLE');
  });
});

describe('happy path + response headers (AC10-AC16)', () => {
  it('streams the upstream bytes verbatim under our own synthesized headers', async () => {
    await build();
    h.ebookStream.bytes = new Uint8Array([7, 8, 9, 10, 11, 12]);
    h.ebookStream.chunks = 3;
    const res = await download(GOOD_ID, '?title=The%20Hobbit', await cookiesFor('active'));

    expect(res.statusCode).toBe(200);
    expect(new Uint8Array(res.rawPayload)).toEqual(h.ebookStream.bytes);
    expect(res.headers['content-length']).toBe('6');
    expect(res.headers['content-type']).toBe('application/epub+zip');
    expect(res.headers['content-disposition']).toBe('attachment; filename="The Hobbit.epub"');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['accept-ranges']).toBeUndefined();
    expectNoLeaks(res, 'success');
  });

  it('forwards a legitimate content-length of 0 and sends an empty 200 (AC11, AC36)', async () => {
    await build();
    h.ebookStream.bytes = new Uint8Array(0);
    h.ebookStream.contentLength = 0;
    const res = await download(GOOD_ID, '', await cookiesFor('active'));
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-length']).toBe('0');
    expect(res.rawPayload.byteLength).toBe(0);
    expect(res.headers['content-disposition']).toBe(`attachment; filename="${GOOD_ID}.epub"`);
  });

  it('omits content-length entirely when the client parsed none (AC11)', async () => {
    await build();
    h.ebookStream.contentLength = null;
    const res = await download(GOOD_ID, '', await cookiesFor('active'));
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-length']).toBeUndefined();
    expect(new Uint8Array(res.rawPayload)).toEqual(h.ebookStream.bytes);
  });

  it.each([
    ['text/html', 'application/octet-stream'],
    [null, 'application/octet-stream'],
    ['application/epub+zip; charset=utf-8', 'application/epub+zip'],
    ['Application/EPUB+ZIP; Charset=UTF-8', 'application/epub+zip'],
  ])('never forwards content-type verbatim: %s becomes %s (AC12, F25)', async (upstream, expected) => {
    await build();
    h.ebookStream.contentType = upstream;
    const res = await download(GOOD_ID, '', await cookiesFor('active'));
    expect(res.headers['content-type']).toBe(expected);
  });

  it('ignores a Range request header — no partial content, no accept-ranges (AC16)', async () => {
    await build();
    h.ebookStream.bytes = new Uint8Array(Array.from({ length: 200 }, (_, i) => i % 251));
    const res = await h.app.inject({
      method: 'GET',
      url: URL_FOR(GOOD_ID),
      headers: { range: 'bytes=0-99' },
      cookies: await cookiesFor('active'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.byteLength).toBe(200);
    expect(res.headers['accept-ranges']).toBeUndefined();
  });

  it('derives the content-type decision purely from the upstream media type (unit)', () => {
    expect(proxyContentType('application/epub+zip')).toBe('application/epub+zip');
    expect(proxyContentType('  APPLICATION/Epub+Zip ; q=1 ')).toBe('application/epub+zip');
    expect(proxyContentType('application/epub')).toBe('application/octet-stream');
    expect(proxyContentType('')).toBe('application/octet-stream');
    expect(proxyContentType(null)).toBe('application/octet-stream');
  });
});

describe('title policy (AC34, AC13, AC19)', () => {
  it.each([
    ['absent', '', `${GOOD_ID}.epub`],
    ['empty', '?title=', `${GOOD_ID}.epub`],
    ['repeated (an ARRAY from fast-querystring)', '?title=A&title=B', `${GOOD_ID}.epub`],
    ['fully stripped', '?title=%3F%3F%3F', `${GOOD_ID}.epub`],
    ['ordinary', '?title=Dune', 'Dune.epub'],
    ['needing sanitization', '?title=a%2Fb%3Ac', 'abc.epub'],
  ])('a %s title yields filename="%s"', async (_label, query, expected) => {
    await build();
    const res = await download(GOOD_ID, query, await cookiesFor('active'));
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toBe(`attachment; filename="${expected}"`);
  });

  it('adds an RFC 5987 filename* for a non-ASCII title, and never 500s on any of these', async () => {
    await build();
    const res = await download(GOOD_ID, `?title=${encodeURIComponent('Cronica\u0301')}`, await cookiesFor('active'));
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain("filename*=UTF-8''");
  });
});

// ---------------------------------------------------------------------------
// AC21, table-driven (F9) so every row and sub-case is covered by construction rather than by a
// hand-picked sample. The `NON_JSON` variants are the #173 bodiless case: they prove the mapping
// keys on the STATUS, not on the companion code string.
// ---------------------------------------------------------------------------
const UPSTREAM_MESSAGE = `Narratorr GET /api/v1/books/${GOOD_ID}/companion-epub failed`;

interface ErrorRow {
  label: string;
  error: () => unknown;
  status: number;
  code: string;
  retryAfter?: string;
}

const ERROR_ROWS: ErrorRow[] = [
  { label: '409 + companion_epub_disabled', error: () => new NarratorrError(409, 'companion_epub_disabled', UPSTREAM_MESSAGE), status: 403, code: 'EBOOKS_DISABLED' },
  { label: '409 bodiless (NON_JSON)', error: () => new NarratorrError(409, 'NON_JSON', UPSTREAM_MESSAGE), status: 403, code: 'EBOOKS_DISABLED' },
  { label: '404 + companion_epub_unavailable', error: () => new NarratorrError(404, 'companion_epub_unavailable', UPSTREAM_MESSAGE), status: 404, code: 'EBOOK_UNAVAILABLE' },
  { label: '404 bodiless (NON_JSON)', error: () => new NarratorrError(404, 'NON_JSON', UPSTREAM_MESSAGE), status: 404, code: 'EBOOK_UNAVAILABLE' },
  { label: '400 (never an existence oracle)', error: () => new NarratorrError(400, 'BAD_REQUEST', UPSTREAM_MESSAGE), status: 404, code: 'EBOOK_UNAVAILABLE' },
  { label: '503 + companion_epub_busy', error: () => new NarratorrError(503, 'companion_epub_busy', UPSTREAM_MESSAGE), status: 503, code: 'EBOOK_BUSY', retryAfter: '5' },
  { label: '503 bodiless (NON_JSON)', error: () => new NarratorrError(503, 'NON_JSON', UPSTREAM_MESSAGE), status: 503, code: 'EBOOK_BUSY', retryAfter: '5' },
  { label: '401', error: () => new NarratorrError(401, 'UNAUTHORIZED', UPSTREAM_MESSAGE), status: 502, code: 'NARRATORR_UNAVAILABLE' },
  { label: '403', error: () => new NarratorrError(403, 'FORBIDDEN', UPSTREAM_MESSAGE), status: 502, code: 'NARRATORR_UNAVAILABLE' },
  { label: '500', error: () => new NarratorrError(500, 'HTTP_500', UPSTREAM_MESSAGE), status: 502, code: 'NARRATORR_UNAVAILABLE' },
  { label: 'NETWORK (status 0)', error: () => new NarratorrError(0, 'NETWORK', UPSTREAM_MESSAGE), status: 502, code: 'NARRATORR_UNAVAILABLE' },
  // #213 split the status-0 class into NETWORK/TIMEOUT; TIMEOUT is inert here — same row as NETWORK.
  { label: 'TIMEOUT (status 0)', error: () => new NarratorrError(0, 'TIMEOUT', UPSTREAM_MESSAGE), status: 502, code: 'NARRATORR_UNAVAILABLE' },
  { label: 'NO_BODY', error: () => new NarratorrError(204, 'NO_BODY', UPSTREAM_MESSAGE), status: 502, code: 'NARRATORR_UNAVAILABLE' },
  { label: 'NON_JSON with an unmapped status', error: () => new NarratorrError(418, 'NON_JSON', UPSTREAM_MESSAGE), status: 502, code: 'NARRATORR_UNAVAILABLE' },
  { label: 'a raw non-NarratorrError (F22)', error: () => new TypeError('undici exploded'), status: 502, code: 'NARRATORR_UNAVAILABLE' },
];

describe('AC21 error mapping — one case per row, at the OPEN (F9, F22, F32)', () => {
  it.each(ERROR_ROWS.map((r) => [r.label, r] as const))('%s', async (_label, row) => {
    await build();
    h.ebookStream.openError = row.error();
    const res = await download(GOOD_ID, '', await cookiesFor('active'));

    expect(res.statusCode).toBe(row.status);
    expect(res.json().error.code).toBe(row.code);
    if (row.retryAfter) expect(res.headers['retry-after']).toBe(row.retryAfter);
    // F32: exactly one open even on a mapped FAILURE — a retry-on-error implementation would
    // satisfy AC8 on the success path alone.
    expect(h.ebookStream.opened).toEqual([GOOD_ID]);
    // No success-only header survives onto an error envelope (AC25's shape, at the open).
    expect(res.headers['content-disposition']).toBeUndefined();
    expect(res.headers['cache-control']).not.toBe('private, no-store');
    expectNoLeaks(res, `open failure ${row.label}`);
  });
});

describe('AC21/AC25 error mapping — the same rows at the PEEKED FIRST READ', () => {
  it.each(ERROR_ROWS.map((r) => [r.label, r] as const))('%s', async (_label, row) => {
    await build();
    h.ebookStream.firstReadError = row.error();
    const res = await download(GOOD_ID, '', await cookiesFor('active'));

    expect(res.statusCode).toBe(row.status);
    expect(res.json().error.code).toBe(row.code);
    // The peek is what buys this: NONE of the success-only headers was ever committed, and the
    // content-length belongs to the JSON envelope rather than to the upstream body.
    expect(res.headers['content-disposition']).toBeUndefined();
    expect(res.headers['cache-control']).not.toBe('private, no-store');
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['content-length']).toBe(String(Buffer.byteLength(res.body)));
    expect(h.ebookStream.opened).toEqual([GOOD_ID]);
    expectNoLeaks(res, `first-read failure ${row.label}`);
  });
});

describe('control-code provenance — only status 0 may be read as locally authored (AC39)', () => {
  it('503s NOT_CONFIGURED carrying OUR message when the holder authored it', async () => {
    await build();
    // Reached through the GENUINE holder, so the error under test is the one construction site
    // whose message is our own literal. The capability has to be pinned `true` for the request to
    // get past the feature gate: an unconfigured holder otherwise resolves the probe to `false`
    // (FeatureService treats NOT_CONFIGURED as an immediate, unrecorded `false`) and the download
    // is refused as EBOOKS_DISABLED before any open — which is the stale-window shape this row
    // exists for.
    h.narratorrHolder.set(null);
    vi.spyOn(h.features, 'ebooksCapability').mockResolvedValue(true);
    const res = await download(GOOD_ID, '', await cookiesFor('active'));
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('NOT_CONFIGURED');
    expect(res.json().error.message).toContain('Settings page');
    expectNoLeaks(res, 'NOT_CONFIGURED');
  });

  it('502s an HTTP-sourced NOT_CONFIGURED and drops its message (a hostile narratorr cannot forge it)', async () => {
    await build();
    h.ebookStream.openError = new NarratorrError(500, 'NOT_CONFIGURED', `see ${UPSTREAM_POSIX_PATH}`);
    const res = await download(GOOD_ID, '', await cookiesFor('active'));
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('NARRATORR_UNAVAILABLE');
    expect(res.body).not.toContain(UPSTREAM_POSIX_PATH);
    expectNoLeaks(res, 'forged NOT_CONFIGURED');
  });

  it('502s an HTTP-sourced ABORTED — it never takes the silent no-response branch', async () => {
    // The caller is plainly connected here (inject completes), so an implementation that keyed
    // "client gone" on `upstreamCode === 'ABORTED'` would hang or answer nothing.
    await build();
    h.ebookStream.openError = new NarratorrError(500, 'ABORTED', UPSTREAM_MESSAGE);
    const res = await download(GOOD_ID, '', await cookiesFor('active'));
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('NARRATORR_UNAVAILABLE');
  });
});

describe('message hygiene (AC22, AC23)', () => {
  it.each([
    ['403 EBOOKS_DISABLED', () => new NarratorrError(409, 'companion_epub_disabled', UPSTREAM_MESSAGE)],
    ['404 EBOOK_UNAVAILABLE', () => new NarratorrError(404, 'companion_epub_unavailable', UPSTREAM_MESSAGE)],
  ])('never reuses an upstream message on the %s branch', async (_label, mk) => {
    await build();
    h.ebookStream.openError = mk();
    const res = await download(GOOD_ID, '', await cookiesFor('active'));
    expect(res.body).not.toContain('Narratorr GET');
    expect(res.body).not.toContain('/api/v1');
    expect(res.body).not.toContain('companion-epub');
  });
});

describe('mid-stream failure (AC24)', () => {
  it('never resolves to a clean 200 whose body is a chunk followed by JSON', async () => {
    await build();
    h.ebookStream.bytes = new Uint8Array([1, 2, 3, 4]);
    h.ebookStream.chunks = 2;
    h.ebookStream.midStreamError = new TypeError('upstream died mid-body');

    // The response never COMPLETES: Fastify destroys the raw response once the wrapper stream
    // errors after headers are sent, so `inject()` cannot resolve to a clean 200 whose body is
    // the single chunk followed by a JSON envelope. (The authoritative socket-destroy assertion
    // is the real-socket file; this pins the envelope-level behavior.)
    await expect(download(GOOD_ID, '', await cookiesFor('active'))).rejects.toThrow(
      /destroyed before completion/,
    );
  });
});

describe('rate limiting, per user (AC29-AC31)', () => {
  // `@fastify/rate-limit`'s LocalStore reads the AMBIENT `Date.now()` (store/LocalStore.js:12) to
  // decide which one-minute bucket a request lands in, so asserting the exact 10th/11th transition
  // against the wall clock is a bet that no pause ever straddles a minute boundary mid-test. Freeze
  // Date — and ONLY Date (`toFake`), so `setTimeout` and the real event loop keep working for the
  // app, the in-memory DB and `inject()` — and the bucket becomes deterministic regardless of how
  // long the run is stalled.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: FROZEN_NOW });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it(`caps one user at ${EBOOK_DOWNLOAD_MAX} per window and leaves a second user untouched (AC30)`, async () => {
    await build();
    const alice = await cookiesFor('active', { username: 'alice' });
    const bob = await cookiesFor('active', { username: 'bob' });

    for (let i = 0; i < EBOOK_DOWNLOAD_MAX; i += 1) {
      expect((await download(GOOD_ID, '', alice)).statusCode, `alice #${i}`).toBe(200);
    }
    const tripped = await download(GOOD_ID, '', alice);
    expect(tripped.statusCode).toBe(429);
    expect(tripped.json().error.code).toBe('RATE_LIMITED');
    expectNoLeaks(tripped, '429');

    expect((await download(GOOD_ID, '', bob)).statusCode).toBe(200);

    // With the clock frozen the bucket is now provably OURS to move: stepping past the declared
    // window must free the same user again. This turns the frozen clock from a defensive measure
    // into an asserted one — it pins both edges of the transition, and it pins
    // EBOOK_DOWNLOAD_WINDOW's real value rather than trusting the constant.
    vi.setSystemTime(new Date(FROZEN_NOW.getTime() + 61_000));
    expect((await download(GOOD_ID, '', alice)).statusCode, 'the window must reset the cap').toBe(200);
  });

  it('never caps in AUTH_BYPASS mode — every request is the dev admin there (AC31)', async () => {
    await build({ config: { authMode: 'bypass' } });
    for (let i = 0; i < EBOOK_DOWNLOAD_MAX + 3; i += 1) {
      expect((await download()).statusCode, `bypass #${i}`).toBe(200);
    }
  });
});

/** Enumerate the registered surface through an `onRoute` collector (the manifest-test pattern). */
async function collectRoutes(): Promise<RouteOptions[]> {
  const raw: RouteOptions[] = [];
  const harness = await buildRouteApp({
    register: (app: FastifyInstance, deps) => {
      app.addHook('onRoute', (r: RouteOptions) => {
        raw.push(r);
      });
      registerEbookRoutes(app, deps);
    },
  });
  await harness.app.close();
  return raw;
}
