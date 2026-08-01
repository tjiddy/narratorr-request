import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import {
  startIntegrationScenario,
  expectAllUpstreamGets,
  expectKeyAccepted,
  INTEGRATION_SENDER_FROM,
  type IntegrationScenario,
} from '../test-support/integration-harness.js';
import { UPSTREAM_DISPOSITION_NAME, UPSTREAM_POSIX_PATH } from '../test-support/leak-sentinels.js';

// ---------------------------------------------------------------------------
// The cross-app integration suite, capability → search → download (issue #150).
//
// NO MSW is registered in this file, and nothing it imports registers any: MSW honors an abort
// only while a resolver is still pending and re-buffers passthrough bodies, so a mid-body abort
// (AC17) behaves IDENTICALLY for correct and broken code under it — the assertion would be
// vacuous (curated learning `msw-cannot-test-body-read-abort`). Everything here runs against a
// real `node:http` fake narratorr, a real `app.listen(0)` and a real `fetch`.
//
// What this file adds over the per-leg suites: the REAL client graph, composed the way
// `src/server/index.ts` composes it, from DB-stored ENCRYPTED connector settings, with every route
// family registered together — so one app and one connection generation carry the whole path, and
// the fake refuses any request that does not present the configured api key.
// ---------------------------------------------------------------------------

const BOOK = 'bk_companion150';
const TITLE = 'Quiet Harbour';

/** A deterministic EPUB fixture — ASCII filler, so no sentinel can appear inside it by accident. */
function epubFixture(size: number): Buffer {
  const buf = Buffer.alloc(size, 0x41);
  buf.write('PK', 0, 'latin1');
  return buf;
}

const EPUB = epubFixture(4096);

/** narratorr's metadata-search answer, with the companion nested in the library annotation. */
function searchBody(sizeBytes: number): unknown {
  return {
    data: [
      {
        asin: 'B0INTEG150',
        title: TITLE,
        authors: [{ name: 'A. Writer' }],
        narrators: [{ name: 'N. Reader' }],
        cover: null,
        library: { bookId: BOOK, status: 'imported', companionEbook: { format: 'epub', sizeBytes } },
      },
    ],
    total: 1,
  };
}

/**
 * A FIXED instant for the whole file. Session minting and verification read the ambient clock, so
 * the suite pins it rather than letting a host clock adjustment decide whether a scenario's cookie
 * is still valid.
 *
 * `toFake: ['Date']` is the load-bearing part (curated learning `vitest-tofake-date-only`): plain
 * fake timers would also fake `setTimeout`/`setImmediate`, which stalls the very things this suite
 * is built on — a listening Fastify instance, libSQL migrations and real socket I/O — turning a
 * failure into a hang. Faking Date alone leaves the event loop intact. Restored in `afterEach`,
 * because `vi.restoreAllMocks()` does NOT restore timers.
 */
const FROZEN_NOW = new Date('2026-07-29T12:00:00.000Z');

let s: IntegrationScenario | null = null;

beforeEach(() => {
  // Before the scenario boots: the session cookie has to be minted under the same frozen clock that
  // later verifies it.
  vi.useFakeTimers({ toFake: ['Date'], now: FROZEN_NOW });
});

afterEach(async () => {
  // AC7: the app AND both fakes are closed on the same teardown, so no handle outlives the file.
  await s?.close();
  s = null;
  vi.useRealTimers();
});

/** A real HTTP GET at the running app. */
const get = (scenario: IntegrationScenario, path: string, cookie: string): Promise<Response> =>
  fetch(`${scenario.baseUrl}${path}`, { headers: { cookie } });

const post = (scenario: IntegrationScenario, path: string, cookie: string): Promise<Response> =>
  fetch(`${scenario.baseUrl}${path}`, { method: 'POST', headers: { cookie } });

/**
 * Drain a response body, RETAINING every chunk that arrived and capturing the read failure instead
 * of throwing it. Both halves matter for the truncation case: the failure IS the assertion, and the
 * bytes the client already saw are a swept surface that `arrayBuffer()` would throw away.
 */
async function readUntilError(res: Response): Promise<{ chunks: Uint8Array[]; error: unknown }> {
  const reader = res.body!.getReader();
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) return { chunks, error: null };
      chunks.push(result.value);
    }
  } catch (err: unknown) {
    return { chunks, error: err };
  }
}

describe('the happy path, end to end over real sockets', () => {
  it('carries capability → search → download through ONE app and ONE connection generation', async () => {
    s = await startIntegrationScenario();
    s.upstream.search = { status: 200, body: searchBody(EPUB.byteLength) };
    s.upstream.companionEpub = {
      kind: 'body',
      bytes: EPUB,
      chunkSize: 512,
      // The upstream picks a filename; our route must ignore it entirely (it is a leak sentinel).
      contentDisposition: `attachment; filename="${UPSTREAM_DISPOSITION_NAME}"`,
    };
    const { cookie } = await s.activeUser();

    // AC8 — the capability the fake advertises AND the admin opt-in, composed by the real resolver.
    const features = await get(s, '/api/features', cookie);
    const featuresBody = await features.text();
    expect(features.status).toBe(200);
    expect(JSON.parse(featuresBody)).toEqual({
      ebooksEnabled: true,
      kindleDeliveryAvailable: true,
      kindleSenderEmail: INTEGRATION_SENDER_FROM,
    });
    s.sweep('GET /api/features', features, featuresBody);

    // AC9 — the annotation survives the REAL JSON client and the vendored (non-`.strict()`) schema
    // into our own response body, with the advertised size intact.
    const search = await get(s, `/api/search?q=${encodeURIComponent(TITLE)}`, cookie);
    const searchBodyText = await search.text();
    expect(search.status).toBe(200);
    const results = (JSON.parse(searchBodyText) as { data: Array<Record<string, unknown>> }).data;
    expect(results).toHaveLength(1);
    expect(results[0]?.library).toEqual({
      bookId: BOOK,
      status: 'imported',
      companionEbook: { format: 'epub', sizeBytes: EPUB.byteLength },
    });
    // The JSON client's credential path, positively received — not merely "no 401 was seen".
    expectKeyAccepted(s.upstream, '/api/v1/metadata/search');
    s.sweep('GET /api/search', search, searchBodyText);

    // AC10 — the bytes, exactly, under headers we own.
    const download = await get(s, `/api/ebooks/${BOOK}/download?title=${encodeURIComponent(TITLE)}`, cookie);
    expect(download.status).toBe(200);
    const received = Buffer.from(await download.arrayBuffer());
    // BYTE equality, not a decoded string: a transcoding bug must not be able to pass this.
    expect(received.equals(EPUB)).toBe(true);
    expect(download.headers.get('content-length')).toBe(String(EPUB.byteLength));
    expect(download.headers.get('content-type')).toBe('application/epub+zip');
    // OUR filename, derived by `epub-filename` from the caller's own title — never the upstream's.
    expect(download.headers.get('content-disposition')).toBe(`attachment; filename="${TITLE}.epub"`);
    expectKeyAccepted(s.upstream, '/companion-epub');
    expect(s.upstream.companionOpens).toBe(1);
    // Every upstream endpoint this feature consumes is a GET, asserted as a positive METHOD receipt
    // — the fake refuses anything else, so a client that changed verb cannot pass this suite.
    expectAllUpstreamGets(s.upstream);
    s.sweep('GET /api/ebooks/:bookId/download', download, received.toString('latin1'));

    // The log sweep is only worth anything if the capture is LIVE — pin that the destination
    // actually received this path's lines, in both the parsed and the raw view (AC6).
    const captured = s.logs.objects() as Array<{ req?: { url?: string } }>;
    expect(captured.some((line) => line.req?.url?.startsWith(`/api/ebooks/${BOOK}/download`))).toBe(true);
    expect(s.logs.raw()).toContain('/api/search');
  }, 30_000);
});

describe('an old narratorr (capability 404) fails closed', () => {
  it('reports the feature off and refuses BOTH ebook routes with ZERO companion traffic', async () => {
    s = await startIntegrationScenario();
    // A pre-#1961 narratorr has no such route at all.
    s.upstream.capabilities = { status: 404, body: { error: { code: 'NOT_FOUND', message: 'no such route' } } };
    s.upstream.companionEpub = { kind: 'body', bytes: EPUB };
    const { cookie } = await s.activeUser({ kindleEmail: null });

    const features = await get(s, '/api/features', cookie);
    const featuresBody = await features.text();
    expect(features.status).toBe(200);
    expect(JSON.parse(featuresBody)).toEqual({
      ebooksEnabled: false,
      kindleDeliveryAvailable: false,
      kindleSenderEmail: null,
    });
    s.sweep('GET /api/features (capability 404)', features, featuresBody);

    const download = await get(s, `/api/ebooks/${BOOK}/download`, cookie);
    const downloadBody = await download.text();
    expect(download.status).toBe(403);
    expect(JSON.parse(downloadBody).error.code).toBe('EBOOKS_DISABLED');
    s.sweep('GET /api/ebooks/:bookId/download (capability 404)', download, downloadBody);

    const send = await post(s, `/api/ebooks/${BOOK}/send-to-kindle`, cookie);
    const sendBody = await send.text();
    expect(send.status).toBe(403);
    expect(JSON.parse(sendBody).error.code).toBe('EBOOKS_DISABLED');
    s.sweep('POST /api/ebooks/:bookId/send-to-kindle (capability 404)', send, sendBody);

    // Failing closed means NO upstream companion traffic at all — not a refusal issued after one.
    expect(s.upstream.companionOpens).toBe(0);
    expect(s.smtp.transactions).toHaveLength(0);
  }, 30_000);
});

describe('upstream refusals map to our envelope', () => {
  it('turns a 503 companion_epub_busy into our retryable EBOOK_BUSY, message and all', async () => {
    s = await startIntegrationScenario();
    s.upstream.companionEpub = {
      kind: 'error',
      status: 503,
      code: 'companion_epub_busy',
      // The upstream message names a filesystem path on purpose: if ours ever echoed it, the sweep
      // below is what catches it.
      message: `companion epub is being prepared from ${UPSTREAM_POSIX_PATH}`,
    };
    const { cookie } = await s.activeUser();

    const res = await get(s, `/api/ebooks/${BOOK}/download`, cookie);
    const body = await res.text();
    expect(res.status).toBe(503);
    expect(JSON.parse(body).error.code).toBe('EBOOK_BUSY');
    expect(res.headers.get('retry-after')).toBe('5');
    // Our envelope, never the upstream's own code string or text.
    expect(body).not.toContain('companion_epub_busy');
    expect(s.upstream.companionOpens).toBe(1);
    s.sweep('GET /api/ebooks/:bookId/download (upstream 503)', res, body);
  }, 30_000);
});

describe('a mid-body upstream abort truncates the client', () => {
  it('REJECTS the body read — a 200 whose body resolves is a failure of this assertion', async () => {
    s = await startIntegrationScenario();
    // Headers plus a partial body, then the socket is destroyed. The advertised length is the FULL
    // one, so the frame the client sees is genuinely broken.
    s.upstream.companionEpub = { kind: 'abort', bytes: EPUB, afterBytes: 512 };
    const { cookie } = await s.activeUser();

    const res = await get(s, `/api/ebooks/${BOOK}/download`, cookie);
    expect(res.status).toBe(200);
    // Read chunk by chunk rather than through `arrayBuffer()`: the bytes delivered BEFORE the abort
    // are client-visible and must be swept too (AC22), and `arrayBuffer()` discards them.
    const { chunks, error } = await readUntilError(res);
    // Not "rejects or is short", and not a byte-count comparison: the READ ITSELF must reject. A
    // body that reaches a clean end leaves `error` null and fails here however many bytes it
    // carried — the clean-short control below is what proves that is a real distinction.
    expect(error, 'the truncated body read resolved instead of rejecting').not.toBeNull();

    const partial = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    expect(partial.byteLength).toBeLessThan(EPUB.byteLength);
    // Whatever DID arrive is genuine upstream payload, not synthesized filler. No LOWER bound is
    // asserted on the length: the abort is a socket destruction, and whether undici surfaces the
    // already-buffered bytes or discards them with the reset is the client's business, not a
    // property of our route.
    expect(EPUB.subarray(0, partial.byteLength).equals(partial)).toBe(true);
    s.sweep('GET /api/ebooks/:bookId/download (mid-body abort)', res, partial.toString('latin1'));
  }, 30_000);

  it('DISCRIMINATES: a genuinely clean short body resolves, so the rejection above means something', async () => {
    // The control. If a clean EOF also rejected, the assertion above would be measuring undici's
    // framing rather than our socket destruction — and the whole real-server harness would be
    // certifying nothing.
    s = await startIntegrationScenario();
    s.upstream.companionEpub = { kind: 'clean-short', bytes: EPUB, sendBytes: 512 };
    const { cookie } = await s.activeUser();

    const res = await get(s, `/api/ebooks/${BOOK}/download`, cookie);
    expect(res.status).toBe(200);
    const received = Buffer.from(await res.arrayBuffer());
    expect(received.byteLength).toBe(512);
    expect(received.equals(EPUB.subarray(0, 512))).toBe(true);
    s.sweep('GET /api/ebooks/:bookId/download (clean short body)', res, received.toString('latin1'));
  }, 30_000);
});
