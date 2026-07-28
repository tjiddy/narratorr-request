import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { http, HttpResponse, delay } from 'msw';
import { setupServer } from 'msw/node';
import { NarratorrClient, NarratorrError } from './narratorr-client.js';
import { errorBody, errorEnvelopeSchema } from '../../shared/schemas/v1/common.js';
import { v1CapabilitiesSchema } from '../../shared/schemas/v1/capabilities.js';
import { narratorrV1Handlers, resetMockNarratorrState, MOCK_BASE_URL } from '../mocks/narratorr-v1.js';

const server = setupServer(...narratorrV1Handlers());

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  resetMockNarratorrState();
});
afterAll(() => server.close());

const client = new NarratorrClient({ baseUrl: MOCK_BASE_URL, apiKey: 'test-key' });

describe('NarratorrClient parsing (happy path against the mock)', () => {
  it('parses metadata search results through the contract', async () => {
    const results = await client.searchMetadata('hail mary');
    expect(results).toHaveLength(1);
    expect(results[0]?.asin).toBe('B07KCQDQR9');
    expect(results[0]?.title).toBe('Project Hail Mary');
  });

  it('is idempotent on ASIN for addBook (201 then 409→existingId resolves to the same book)', async () => {
    const a = await client.addBook('B07KCQDQR9'); // 201 created
    const b = await client.addBook('B07KCQDQR9'); // 409 + existingId → fetched
    expect(a.id).toBe(b.id);
  });

  it('surfaces an unresolvable ASIN as a terminal 422 with the asin_not_resolved code', async () => {
    await expect(client.addBook('B000UNKNOWN')).rejects.toMatchObject({
      upstreamStatus: 422,
      upstreamCode: 'asin_not_resolved',
    });
  });

  it('surfaces the per-code 422 add-error vocabulary (edition_rejected / invalid_record)', async () => {
    // The fixture keys these codes off marker ASINs so each handoff branch is reachable.
    await expect(client.addBook('B000EDITIONX')).rejects.toMatchObject({
      upstreamStatus: 422,
      upstreamCode: 'edition_rejected',
    });
    await expect(client.addBook('B000INVALIDX')).rejects.toMatchObject({
      upstreamStatus: 422,
      upstreamCode: 'invalid_record',
    });
  });

  it('getBook reflects a pre-imported library book as imported', async () => {
    const added = await client.addBook('B075FYBP8H'); // Dune, already in library
    const fetched = await client.getBook(added.id);
    expect(fetched.status).toBe('imported');
  });
});

describe('NarratorrClient error handling', () => {
  it('maps the v1 error envelope to a NarratorrError carrying upstream status + code', async () => {
    server.use(
      http.get(`${MOCK_BASE_URL}/api/v1/metadata/search`, () =>
        HttpResponse.json({ error: { code: 'BOOM', message: 'kaboom' } }, { status: 503 }),
      ),
    );
    await expect(client.searchMetadata('x')).rejects.toMatchObject({
      statusCode: 502,
      upstreamStatus: 503,
      upstreamCode: 'BOOM',
    });
  });

  it('flags a contract mismatch when the body has the wrong shape', async () => {
    server.use(
      http.get(`${MOCK_BASE_URL}/api/v1/metadata/search`, () =>
        HttpResponse.json({ data: [{ asin: 123 }] }),
      ),
    );
    const err = await client.searchMetadata('x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NarratorrError);
    expect((err as NarratorrError).upstreamCode).toBe('CONTRACT_MISMATCH');
  });

  it('surfaces a missing API key as a 401 upstream error', async () => {
    const keyless = new NarratorrClient({ baseUrl: MOCK_BASE_URL, apiKey: '' });
    await expect(keyless.searchMetadata('x')).rejects.toMatchObject({
      upstreamStatus: 401,
      upstreamCode: 'UNAUTHORIZED',
    });
  });

  it('returns 404 for an unknown book id', async () => {
    await expect(client.getBook('bk_doesnotexist')).rejects.toMatchObject({
      upstreamStatus: 404,
    });
  });

  it('maps a transport failure to upstreamStatus 0 / NETWORK', async () => {
    server.use(http.get(`${MOCK_BASE_URL}/api/v1/metadata/search`, () => HttpResponse.error()));
    await expect(client.searchMetadata('x')).rejects.toMatchObject({
      statusCode: 502,
      upstreamStatus: 0,
      upstreamCode: 'NETWORK',
    });
  });

  it('maps a request that exceeds the timeout to a NETWORK error ending in "timed out"', async () => {
    server.use(
      http.get(`${MOCK_BASE_URL}/api/v1/metadata/search`, async () => {
        await delay(200);
        return HttpResponse.json({ data: [], total: 0 });
      }),
    );
    const slow = new NarratorrClient({ baseUrl: MOCK_BASE_URL, apiKey: 'test-key', timeoutMs: 10 });
    const err = await slow.searchMetadata('x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NarratorrError);
    expect((err as NarratorrError).upstreamCode).toBe('NETWORK');
    expect((err as NarratorrError).message).toMatch(/timed out$/);
  });

  it('times out a response whose body stalls past the timeout (not just its headers)', async () => {
    // A real socket over native fetch is required here. MSW honors an abort only while its
    // handler resolver is pending (the header-stall case above), and it re-buffers passthrough
    // responses — so under MSW the abort always lands during `fetch()`, which can't tell the
    // body-read path apart. We take MSW out of the loop for this one request.
    //
    // The timings are picked so the deadline splits the header read from the body read:
    // headers + a partial body flush immediately (well under the 100ms `timeoutMs`, even with
    // localhost connection setup), then the rest of the body lands at 400ms — past the deadline.
    // Post-fix the abort lands inside `res.text()` at ~100ms → NETWORK/timed out. Pre-fix the
    // timer was cleared once headers arrived, so the body read ran unbounded and would resolve
    // the full JSON at 400ms → `searchMetadata` returns `[]` and the NarratorrError assertion
    // fails. Auto-completing the body (rather than stalling forever) keeps that pre-fix failure
    // a fast, controlled resolve instead of a hang against the test timeout.
    let bodyTimer: ReturnType<typeof setTimeout> | undefined;
    const stallServer = await new Promise<Server>((resolve) => {
      const s = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"data":'); // headers + partial body flushed now; the rest is delayed
        bodyTimer = setTimeout(() => res.end('[],"total":0}'), 400);
      });
      s.listen(0, '127.0.0.1', () => resolve(s));
    });
    const { port } = stallServer.address() as AddressInfo;
    const stallBaseUrl = `http://127.0.0.1:${port}`;

    server.close(); // restore native fetch so undici's real body-read abort applies
    try {
      const slow = new NarratorrClient({ baseUrl: stallBaseUrl, apiKey: 'test-key', timeoutMs: 100 });
      const err = await slow.searchMetadata('x').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NarratorrError);
      expect((err as NarratorrError).upstreamCode).toBe('NETWORK');
      expect((err as NarratorrError).message).toMatch(/timed out$/);
    } finally {
      server.listen({ onUnhandledRequest: 'error' }); // re-arm MSW for the remaining tests
      if (bodyTimer) clearTimeout(bodyTimer);
      await new Promise<void>((resolve) => stallServer.close(() => resolve()));
    }
  });

  it('rejects a 200 with a non-JSON body as NON_JSON', async () => {
    server.use(
      http.get(`${MOCK_BASE_URL}/api/v1/metadata/search`, () =>
        HttpResponse.text('<html>not json</html>'),
      ),
    );
    await expect(client.searchMetadata('x')).rejects.toMatchObject({ upstreamCode: 'NON_JSON' });
  });

  it('falls back to HTTP_<status> for a non-2xx body that is not the error envelope', async () => {
    server.use(
      http.get(`${MOCK_BASE_URL}/api/v1/metadata/search`, () =>
        HttpResponse.json({ message: 'oops' }, { status: 500 }),
      ),
    );
    await expect(client.searchMetadata('x')).rejects.toMatchObject({
      upstreamStatus: 500,
      upstreamCode: 'HTTP_500',
    });
  });

  it('re-throws a 409 with no existingId and does NOT fetch a book', async () => {
    server.use(
      http.post(`${MOCK_BASE_URL}/api/v1/books`, () =>
        HttpResponse.json(errorBody('book_exists', 'A book with this ASIN already exists.'), {
          status: 409,
        }),
      ),
    );
    const getBookSpy = vi.spyOn(client, 'getBook');
    await expect(client.addBook('B07KCQDQR9')).rejects.toMatchObject({ upstreamStatus: 409 });
    expect(getBookSpy).not.toHaveBeenCalled();
    getBookSpy.mockRestore();
  });
});

describe('NarratorrClient.getSystem (build-info probe, narratorr #1709)', () => {
  it('calls GET /api/v1/system with X-Api-Key and parses version out of the body', async () => {
    let seenKey: string | null = null;
    server.use(
      http.get(`${MOCK_BASE_URL}/api/v1/system`, ({ request }) => {
        seenKey = request.headers.get('x-api-key');
        return HttpResponse.json({ version: 'v1.2.3', commit: 'deadbee', os: 'Linux' });
      }),
    );
    const sys = await client.getSystem();
    expect(sys.version).toBe('v1.2.3');
    expect(sys.commit).toBe('deadbee');
    expect(seenKey).toBe('test-key');
  });

  it('tolerates a lean body carrying only version (consumer-lenient contract)', async () => {
    server.use(
      http.get(`${MOCK_BASE_URL}/api/v1/system`, () => HttpResponse.json({ version: 'v9.9.9' })),
    );
    await expect(client.getSystem()).resolves.toMatchObject({ version: 'v9.9.9' });
  });

  it('flags a body missing version as CONTRACT_MISMATCH', async () => {
    server.use(
      http.get(`${MOCK_BASE_URL}/api/v1/system`, () => HttpResponse.json({ commit: 'abc1234' })),
    );
    const err = await client.getSystem().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NarratorrError);
    expect((err as NarratorrError).upstreamCode).toBe('CONTRACT_MISMATCH');
  });

  it('maps a transport failure to upstreamStatus 0 / NETWORK', async () => {
    server.use(http.get(`${MOCK_BASE_URL}/api/v1/system`, () => HttpResponse.error()));
    await expect(client.getSystem()).rejects.toMatchObject({ upstreamStatus: 0, upstreamCode: 'NETWORK' });
  });
});

describe('NarratorrClient.ping (Settings "Test" probe)', () => {
  it('resolves when the probe book 404s (reachable + authenticated)', async () => {
    // Default handlers 404 the bogus `__healthcheck__` id — that is the success signal.
    await expect(client.ping()).resolves.toBeUndefined();
  });

  it('rejects when the probe is unauthorized (401)', async () => {
    server.use(
      http.get(`${MOCK_BASE_URL}/api/v1/books/:id`, () =>
        HttpResponse.json(errorBody('UNAUTHORIZED', 'Missing X-Api-Key'), { status: 401 }),
      ),
    );
    await expect(client.ping()).rejects.toMatchObject({ upstreamStatus: 401 });
  });

  it('rejects on a transport failure', async () => {
    server.use(http.get(`${MOCK_BASE_URL}/api/v1/books/:id`, () => HttpResponse.error()));
    await expect(client.ping()).rejects.toMatchObject({ upstreamCode: 'NETWORK' });
  });
});

// ---------------------------------------------------------------------------
// Companion ebooks (narratorr #1961) — the vendored contract, exercised end to end
// against the MSW fixture. The mock designates its companion-bearing ASINs from
// PRE_IMPORTED and gates the projection on `imported`, mirroring narratorr's
// exposure predicate (`enabled && imported && available`), so no fixture state
// here is one narratorr can never emit.
// ---------------------------------------------------------------------------
const COMPANION_ASIN = 'B017V4IM1G'; // Mistborn — pre-imported, HAS a companion
const NO_COMPANION_ASIN = 'B075FYBP8H'; // Dune — pre-imported, no companion (the null control)
const COMPANION_SIZE_BYTES = 4096;

describe('companion ebooks — search annotation + book DTO (#1961)', () => {
  it('carries library.companionEbook through the client schema parse', async () => {
    await client.addBook(COMPANION_ASIN);
    const [result] = await client.searchMetadata('mistborn');
    expect(result?.library?.companionEbook).toEqual({ format: 'epub', sizeBytes: COMPANION_SIZE_BYTES });
  });

  it('annotates an in-library book WITHOUT a companion as null', async () => {
    await client.addBook(NO_COMPANION_ASIN);
    const [result] = await client.searchMetadata('dune');
    expect(result?.library?.bookId).toEqual(expect.stringMatching(/^bk_/));
    expect(result?.library?.companionEbook).toBeNull();
  });

  it('leaves a NOT-in-library result with no library annotation at all', async () => {
    // The third UI state: the fixture must not annotate every result.
    const [result] = await client.searchMetadata('hail mary');
    expect(result?.asin).toBe('B07KCQDQR9');
    expect(result?.library).toBeUndefined();
  });

  it('never disagrees between the search annotation and the book DTO for the same ASIN', async () => {
    const added = await client.addBook(COMPANION_ASIN);
    const [result] = await client.searchMetadata('mistborn');
    const book = await client.getBook(added.id);
    expect(book.companionEbook).toEqual({ format: 'epub', sizeBytes: COMPANION_SIZE_BYTES });
    expect(book.companionEbook).toEqual(result?.library?.companionEbook);
  });

  it('returns a null top-level companionEbook for a book without one', async () => {
    const added = await client.addBook(NO_COMPANION_ASIN);
    expect((await client.getBook(added.id)).companionEbook).toBeNull();
  });
});

describe('NarratorrClient.getCapabilities (capability probe, narratorr #1961 / issue #144)', () => {
  const CAPS_URL = `${MOCK_BASE_URL}/api/v1/capabilities`;

  it('parses the capability body through the vendored contract', async () => {
    await expect(client.getCapabilities()).resolves.toEqual({ companionEpub: { enabled: true } });
  });

  it('carries the API key — a keyless client gets a 401, never a "capability missing" answer', async () => {
    // Why the probe MUST be keyed: a keyless probe cannot distinguish "old narratorr" (404) from
    // "bad key" (401), and only the first means unsupported.
    const keyless = new NarratorrClient({ baseUrl: MOCK_BASE_URL, apiKey: '' });
    await expect(keyless.getCapabilities()).rejects.toMatchObject({ upstreamStatus: 401 });
  });

  it('preserves upstreamStatus 404 for BOTH a Fastify-style JSON body and a proxy HTML page', async () => {
    // Status, not code, is the load-bearing discriminator: the two 404 shapes yield DIFFERENT
    // codes (`HTTP_404` vs `NON_JSON`) while meaning exactly the same thing.
    server.use(http.get(CAPS_URL, () => HttpResponse.json({ message: 'Route GET:/api/v1/capabilities not found' }, { status: 404 })));
    await expect(client.getCapabilities()).rejects.toMatchObject({ upstreamStatus: 404, upstreamCode: 'HTTP_404' });

    server.use(http.get(CAPS_URL, () => new HttpResponse('<html><body>404 Not Found</body></html>', { status: 404 })));
    await expect(client.getCapabilities()).rejects.toMatchObject({ upstreamStatus: 404, upstreamCode: 'NON_JSON' });
  });

  it('surfaces a 200 body missing companionEpub.enabled as CONTRACT_MISMATCH (drift, not "unsupported")', async () => {
    server.use(http.get(CAPS_URL, () => HttpResponse.json({ companionEpub: {} })));
    await expect(client.getCapabilities()).rejects.toMatchObject({
      upstreamStatus: 200,
      upstreamCode: 'CONTRACT_MISMATCH',
    });
  });

  it('maps a transport error to upstreamStatus 0 / NETWORK', async () => {
    server.use(http.get(CAPS_URL, () => HttpResponse.error()));
    await expect(client.getCapabilities()).rejects.toMatchObject({ upstreamStatus: 0, upstreamCode: 'NETWORK' });
  });

  it('tolerates an unknown sibling capability (the vendored schema is consumer-lenient)', async () => {
    server.use(http.get(CAPS_URL, () => HttpResponse.json({ companionEpub: { enabled: false }, somethingNew: { enabled: true } })));
    await expect(client.getCapabilities()).resolves.toEqual({ companionEpub: { enabled: false } });
  });
});

describe('companion ebooks — capabilities + byte-stream fixture handlers (#1961)', () => {
  const keyed = { headers: { 'x-api-key': 'test-key' } };

  it('serves the capability probe under the api key and 401s without it', async () => {
    const res = await fetch(`${MOCK_BASE_URL}/api/v1/capabilities`, keyed);
    expect(res.status).toBe(200);
    expect(v1CapabilitiesSchema.parse(await res.json())).toEqual({ companionEpub: { enabled: true } });

    const anon = await fetch(`${MOCK_BASE_URL}/api/v1/capabilities`);
    expect(anon.status).toBe(401);
  });

  it('streams a body whose byte length equals the advertised sizeBytes, with the download headers', async () => {
    const added = await client.addBook(COMPANION_ASIN);
    const res = await fetch(`${MOCK_BASE_URL}/api/v1/books/${added.id}/companion-epub`, keyed);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/epub+zip');
    expect(res.headers.get('content-length')).toBe(String(COMPANION_SIZE_BYTES));
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="[^"]+\.epub"$/);
    expect((await res.arrayBuffer()).byteLength).toBe(COMPANION_SIZE_BYTES);
  });

  it('guards the byte stream with the api key too', async () => {
    const added = await client.addBook(COMPANION_ASIN);
    const res = await fetch(`${MOCK_BASE_URL}/api/v1/books/${added.id}/companion-epub`);
    expect(res.status).toBe(401);
    expect(errorEnvelopeSchema.parse(await res.json()).error.code).toBe('UNAUTHORIZED');
  });

  it('reproduces the three frozen companion_epub_* envelopes verbatim', async () => {
    const cases = [
      ['bk_companiondisabled', 409, 'companion_epub_disabled', 'Companion ebooks are disabled'],
      ['bk_companionbusy', 503, 'companion_epub_busy', 'Too many concurrent companion ebook downloads'],
      ['bk_nosuchbook', 404, 'companion_epub_unavailable', 'Companion ebook is unavailable'],
    ] as const;
    for (const [id, status, code, message] of cases) {
      const res = await fetch(`${MOCK_BASE_URL}/api/v1/books/${id}/companion-epub`, keyed);
      expect(res.status).toBe(status);
      expect(errorEnvelopeSchema.parse(await res.json())).toEqual({ error: { code, message } });
    }
  });

  it('404s an in-library book with no companion (never a distinguishable code)', async () => {
    const added = await client.addBook(NO_COMPANION_ASIN);
    const res = await fetch(`${MOCK_BASE_URL}/api/v1/books/${added.id}/companion-epub`, keyed);
    expect(res.status).toBe(404);
    expect(errorEnvelopeSchema.parse(await res.json()).error.code).toBe('companion_epub_unavailable');
  });

  it('rejects a whitespace-only publicId with a plain 400 (narratorr validates before resolving)', async () => {
    // The producer's param validator is `z.string().trim().min(1)`, so `%20` is a 400
    // while any other nonempty marker resolves to the 404. The validation message is
    // not a stable producer contract — only the status is asserted in substance.
    const res = await fetch(`${MOCK_BASE_URL}/api/v1/books/%20/companion-epub`, keyed);
    expect(res.status).toBe(400);
    const body = errorEnvelopeSchema.parse(await res.json());
    expect(body.error.code).toBe('BAD_REQUEST');
    expect(typeof body.error.message).toBe('string');
  });
});
