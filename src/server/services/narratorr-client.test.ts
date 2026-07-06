import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { http, HttpResponse, delay } from 'msw';
import { setupServer } from 'msw/node';
import { NarratorrClient, NarratorrError } from './narratorr-client.js';
import { errorBody } from '../../shared/schemas/v1/common.js';
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
