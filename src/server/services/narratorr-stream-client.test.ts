import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  NarratorrStreamClient,
  parseContentLength,
  ERROR_BODY_MAX_BYTES,
  DEFAULT_STREAM_HEADER_TIMEOUT_MS,
} from './narratorr-stream-client.js';
import { buildNarratorrClients } from './narratorr-clients.js';
import { NarratorrError } from './narratorr-client.js';
import { errorBody } from '../../shared/schemas/v1/common.js';

// ---------------------------------------------------------------------------
// REAL `node:http`, NO MSW — deliberately. This file registers no `setupServer`, so native
// fetch/undici applies to every test here and no close/re-arm dance is needed (learning
// `msw-cannot-test-body-read-abort`, #95/#109): MSW honors an abort only while a resolver is
// still pending and re-buffers passthrough bodies, so mid-body abort, truncation and
// backpressure all behave identically for correct and broken code under it.
//
// Every server binds an ephemeral port on 127.0.0.1 and is torn down in `afterEach`. Timers
// are generous over localhost connection setup (100ms, not 10ms) so a too-tight deadline
// can't race the abort into `fetch()` and defeat the test.
// ---------------------------------------------------------------------------

const API_KEY = 'stream-test-key';
const HEADER_TIMEOUT_MS = 100;

interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
}

interface FakeServer {
  baseUrl: string;
  requests: RecordedRequest[];
  /** How many responses the CLIENT cut short (socket closed before the response finished). */
  readonly aborted: number;
  /** Resolves once the server has observed at least one client-side abort. */
  whenAborted(): Promise<void>;
  close(): Promise<void>;
}

/** Register a timer the teardown will clear, so a stalled handler can't keep the loop alive. */
type Defer = (ms: number, fn: () => void) => void;

const openServers: FakeServer[] = [];

async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse, defer: Defer) => void,
): Promise<FakeServer> {
  const requests: RecordedRequest[] = [];
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  const defer: Defer = (ms, fn) => {
    timers.push(setTimeout(fn, ms));
  };
  let aborted = 0;
  let notify: (() => void) | null = null;

  const server = createServer((req, res) => {
    requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
    // A client that walks away mid-response makes the socket error (EPIPE/ECONNRESET) — swallow
    // it so a hardening test can't take the whole worker down with an unhandled 'error'.
    res.on('error', () => {});
    req.on('error', () => {});
    res.on('close', () => {
      if (!res.writableFinished) {
        aborted += 1;
        notify?.();
      }
    });
    handler(req, res, defer);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;

  const fake: FakeServer = {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    get aborted() {
      return aborted;
    },
    whenAborted: () =>
      new Promise<void>((resolve) => {
        if (aborted > 0) resolve();
        else notify = resolve;
      }),
    close: async () => {
      for (const t of timers) clearTimeout(t);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  openServers.push(fake);
  return fake;
}

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((s) => s.close()));
  vi.restoreAllMocks();
});

function clientFor(
  s: FakeServer | string,
  overrides: { headerTimeoutMs?: number; errorBodyTimeoutMs?: number } = {},
): NarratorrStreamClient {
  return new NarratorrStreamClient({
    baseUrl: typeof s === 'string' ? s : s.baseUrl,
    apiKey: API_KEY,
    headerTimeoutMs: HEADER_TIMEOUT_MS,
    ...overrides,
  });
}

/** Drain a body to its byte count. Rejects if the stream errors — which several tests want. */
async function readAll(body: ReadableStream<Uint8Array>): Promise<number> {
  const reader = body.getReader();
  let total = 0;
  for (;;) {
    const r = await reader.read();
    if (r.done) return total;
    total += r.value.byteLength;
  }
}

const rejection = (p: Promise<unknown>): Promise<unknown> => p.then(() => null).catch((e: unknown) => e);

describe('NarratorrStreamClient — happy path and the bounded result view', () => {
  it('streams a 200 companion epub, forwarding content-type and the parsed content-length', async () => {
    const payload = Buffer.alloc(4096, 7);
    const s = await startServer((_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/epub+zip',
        'content-length': String(payload.byteLength),
      });
      res.end(payload);
    });

    const result = await clientFor(s).openCompanionEpub('bk_1');
    expect(result.contentType).toBe('application/epub+zip');
    expect(result.contentLength).toBe(payload.byteLength);
    expect(typeof result.contentLength).toBe('number');
    expect(await readAll(result.body)).toBe(payload.byteLength);
  });

  it('preserves a zero-byte companion: Content-Length: 0 is 0, never null', async () => {
    // The contract explicitly round-trips `sizeBytes: 0`, so a `Number(h) || null` coercion is a
    // defect — it would report "length unknown" for a legitimately empty companion.
    const s = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/epub+zip', 'content-length': '0' });
      res.end();
    });

    const result = await clientFor(s).openCompanionEpub('bk_1');
    expect(result.contentLength).not.toBeNull();
    expect(result.contentLength).toBe(0);
    expect(await readAll(result.body)).toBe(0);
  });

  it('reports null for an absent content-length AND an absent content-type, and still streams', async () => {
    // Both null-branches in one response: a chunked body (no length) with no content-type at all.
    // The happy path above pins the present values, so a defaulted `contentType` fails here.
    const s = await startServer((_req, res) => {
      res.writeHead(200, {}); // chunked, no content-type
      res.end(Buffer.alloc(64, 1));
    });

    const result = await clientFor(s).openCompanionEpub('bk_1');
    expect(result.contentLength).toBeNull();
    expect(result.contentType).toBeNull();
    expect(await readAll(result.body)).toBe(64);
  });

  it('exposes ONLY contentType/contentLength/body — no upstream headers, url or key leak through', async () => {
    const s = await startServer((_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/epub+zip',
        'content-length': '3',
        'set-cookie': 'sid=abc',
        // Deliberately NOT forwarded: the proxy route synthesizes its own filename from the
        // book title, never from anything upstream.
        'content-disposition': 'attachment; filename="secret.epub"',
        etag: 'W/"xyz"',
        server: 'narratorr/9',
        'x-narratorr-path': '/srv/media/books/secret.epub',
      });
      res.end('abc');
    });

    const result = await clientFor(s).openCompanionEpub('bk_1');
    expect(Object.keys(result).sort()).toEqual(['body', 'contentLength', 'contentType']);
    const view = JSON.stringify({ contentType: result.contentType, contentLength: result.contentLength });
    expect(view).not.toContain(API_KEY);
    expect(view).not.toContain(s.baseUrl);
    expect(view).not.toContain('/srv/media');
    await readAll(result.body);
  });

  it('issues a GET carrying the configured X-Api-Key', async () => {
    const s = await startServer((_req, res) => {
      res.writeHead(200, { 'content-length': '0' });
      res.end();
    });

    await readAll((await clientFor(s).openCompanionEpub('bk_1')).body);
    // narratorr exposes this endpoint as GET only — a regression to POST would 405 in production
    // while every other assertion here (which ignores the method) stayed green.
    expect(s.requests[0]?.method).toBe('GET');
    expect(s.requests[0]?.headers['x-api-key']).toBe(API_KEY);
  });
});

describe('parseContentLength', () => {
  // The garbage cases can't ride real HTTP: undici/llhttp rejects a malformed `Content-Length`
  // at the protocol layer, so `abc` / `-1` never reach our parser over a socket. The parser is
  // the unit that decides them, so it is asserted directly here; the absent/zero/present cases
  // are pinned end-to-end above.
  it.each([
    ['0', 0],
    ['4096', 4096],
    ['007', 7],
    [null, null],
    ['', null],
    ['abc', null],
    ['-1', null],
    ['1.5', null],
    ['1e3', null],
    ['12abc', null],
    ['9007199254740993', null], // beyond Number.MAX_SAFE_INTEGER — not representable, not trusted
  ])('parses %o to %o', (raw, expected) => {
    expect(parseContentLength(raw)).toBe(expected);
  });
});

describe('NarratorrStreamClient — timeout shape', () => {
  it('bounds HEADER acquisition and aborts the upstream request when it lapses', async () => {
    const s = await startServer((_req, res, defer) => {
      defer(600, () => {
        res.writeHead(200, { 'content-length': '0' });
        res.end();
      });
    });

    const err = await rejection(clientFor(s).openCompanionEpub('bk_1'));
    expect(err).toBeInstanceOf(NarratorrError);
    expect(err).toMatchObject({ upstreamStatus: 0, upstreamCode: 'TIMEOUT' });
    expect((err as NarratorrError).message).toMatch(/timed out$/);
    // Not merely a locally dropped stream — the upstream really saw the request cancelled.
    await s.whenAborted();
    expect(s.aborted).toBe(1);
  });

  it('puts NO deadline on the body: headers flush fast, the body completes long after the header timeout', async () => {
    // The exact scenario `NarratorrClient.request()` (one whole-response timer) must fail and this
    // client must pass — the anti-regression against reusing the JSON client for a 25 MiB EPUB.
    const s = await startServer((_req, res, defer) => {
      res.writeHead(200, { 'content-type': 'application/epub+zip' }); // chunked
      res.write(Buffer.alloc(16, 1));
      defer(400, () => res.end(Buffer.alloc(48, 2)));
    });

    const result = await clientFor(s).openCompanionEpub('bk_1');
    expect(await readAll(result.body)).toBe(64);
  });

  it('clears the header timer on the SUCCESS path', async () => {
    const s = await startServer((_req, res) => {
      res.writeHead(200, { 'content-length': '0' });
      res.end();
    });
    const timers = spyTimers();

    await readAll((await clientFor(s, { headerTimeoutMs: 7777 }).openCompanionEpub('bk_1')).body);
    timers.expectHeaderTimerCleared(7777);
  });

  it('clears the header timer on a FAST FAILURE path, well before the deadline could fire', async () => {
    // A transport failure that rejects immediately would otherwise leave the timer armed for the
    // whole header deadline — an open handle, and an abort aimed at nothing.
    const dead = await deadBaseUrl();
    const timers = spyTimers();

    const err = await rejection(clientFor(dead, { headerTimeoutMs: 30_000 }).openCompanionEpub('bk_1'));
    expect(err).toBeInstanceOf(NarratorrError);
    timers.expectHeaderTimerCleared(30_000);
  });

  it('arms the PRODUCTION 15s default when no timeout is configured — including through the factory', async () => {
    // Every other timeout test supplies a short override, so the shipped default and the
    // `?? DEFAULT_STREAM_HEADER_TIMEOUT_MS` path are otherwise never exercised: the deadline could
    // silently become 0 or unbounded with the suite still green. Asserted on the ARMED DELAY (the
    // request itself fails fast against a dead port) rather than by waiting 15 seconds.
    expect(DEFAULT_STREAM_HEADER_TIMEOUT_MS).toBe(15_000);
    const dead = await deadBaseUrl();

    for (const client of [
      new NarratorrStreamClient({ baseUrl: dead, apiKey: API_KEY }),
      buildNarratorrClients({ baseUrl: dead, apiKey: API_KEY }).stream,
    ]) {
      const timers = spyTimers();
      await rejection(client.openCompanionEpub('bk_1'));
      timers.expectHeaderTimerCleared(DEFAULT_STREAM_HEADER_TIMEOUT_MS);
      vi.restoreAllMocks();
    }
  });
});

/**
 * Watch the client-owned header timer through the globals it uses. `headerTimerCleared` doubles as
 * a "the response headers have landed" probe — the client clears that timer the moment `fetch()`
 * resolves — which is how a test can act strictly AFTER header acquisition without a sleep.
 */
function spyTimers(): {
  headerTimerCleared(delayMs: number): boolean;
  expectHeaderTimerCleared(delayMs: number): void;
} {
  const setSpy = vi.spyOn(globalThis, 'setTimeout');
  const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
  const armedWith = (delayMs: number): unknown[] =>
    setSpy.mock.calls
      .map((call, i) => ({ ms: call[1], handle: setSpy.mock.results[i]?.value as unknown }))
      .filter((t) => t.ms === delayMs)
      .map((t) => t.handle);
  const cleared = (handle: unknown): boolean => clearSpy.mock.calls.some((c) => (c[0] as unknown) === handle);

  return {
    headerTimerCleared: (delayMs) => {
      const armed = armedWith(delayMs);
      return armed.length === 1 && cleared(armed[0]);
    },
    expectHeaderTimerCleared(delayMs) {
      const armed = armedWith(delayMs);
      expect(armed).toHaveLength(1);
      expect(clearSpy.mock.calls.map((c) => c[0] as unknown)).toContain(armed[0]);
    },
  };
}

/** An address nothing is listening on — bind an ephemeral port, then release it. */
async function deadBaseUrl(): Promise<string> {
  const s = await startServer((_req, res) => res.end());
  const url = s.baseUrl;
  await s.close();
  openServers.splice(openServers.indexOf(s), 1);
  return url;
}

describe('NarratorrStreamClient — abort attribution and cancellation', () => {
  it('aborts the UPSTREAM request when the caller signal fires mid-body', async () => {
    const s = await startServer((_req, res, defer) => {
      res.writeHead(200, { 'content-type': 'application/epub+zip' });
      const pump = (): void => {
        if (res.writableEnded || res.destroyed) return;
        res.write(Buffer.alloc(1024, 3));
        defer(25, pump);
      };
      pump();
    });

    const ac = new AbortController();
    const result = await clientFor(s).openCompanionEpub('bk_1', { signal: ac.signal });
    const reader = result.body.getReader();
    expect((await reader.read()).done).toBe(false);

    ac.abort();
    // The stream ERRORS — a consumer can never mistake a cancelled transfer for a clean EOF.
    await expect(
      (async () => {
        for (;;) {
          const r = await reader.read();
          if (r.done) return;
        }
      })(),
    ).rejects.toBeDefined();
    await s.whenAborted();
    expect(s.aborted).toBe(1);
  });

  it('attributes an already-aborted caller signal to ABORTED, never NETWORK, and never opens the socket', async () => {
    const s = await startServer((_req, res) => {
      res.writeHead(200, { 'content-length': '0' });
      res.end();
    });
    const ac = new AbortController();
    ac.abort();

    const err = await rejection(clientFor(s).openCompanionEpub('bk_1', { signal: ac.signal }));
    expect(err).toBeInstanceOf(NarratorrError);
    expect(err).toMatchObject({ upstreamStatus: 0, upstreamCode: 'ABORTED' });
    expect(s.requests).toHaveLength(0);
  });

  it('maps a generic pre-header transport failure to NETWORK / unreachable', async () => {
    const dead = await deadBaseUrl();
    const err = await rejection(clientFor(dead).openCompanionEpub('bk_1'));
    expect(err).toBeInstanceOf(NarratorrError);
    expect(err).toMatchObject({ upstreamStatus: 0, upstreamCode: 'NETWORK' });
    expect((err as NarratorrError).message).toMatch(/unreachable$/);
  });
});

describe('NarratorrStreamClient — the body never degrades to a clean end', () => {
  it('rejects on read when the upstream truncates a declared Content-Length', async () => {
    // undici ENFORCES Content-Length: a short body raises a premature-close error rather than
    // yielding short bytes. This is the precondition for the proxy route destroying the
    // downstream socket instead of ending it.
    const s = await startServer((_req, res, defer) => {
      res.writeHead(200, { 'content-type': 'application/epub+zip', 'content-length': '1000' });
      res.write(Buffer.alloc(400, 5));
      defer(50, () => res.destroy());
    });

    const result = await clientFor(s).openCompanionEpub('bk_1');
    let read = 0;
    const err = await rejection(
      (async () => {
        const reader = result.body.getReader();
        for (;;) {
          const r = await reader.read();
          if (r.done) return;
          read += r.value.byteLength;
        }
      })(),
    );
    expect(err).toBeInstanceOf(Error); // an exception, NOT a clean end
    expect(read).toBeLessThan(1000);
  });

  it('preserves backpressure end-to-end: a consumer that stops reading stalls the producer', async () => {
    const CHUNK = Buffer.alloc(64 * 1024, 9);
    const TOTAL = 32 * 1024 * 1024;
    let written = 0;
    const s = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/epub+zip', 'content-length': String(TOTAL) });
      const pump = (): void => {
        while (written < TOTAL) {
          written += CHUNK.byteLength;
          if (!res.write(CHUNK)) {
            res.once('drain', pump);
            return;
          }
        }
        res.end();
      };
      pump();
    });

    const result = await clientFor(s).openCompanionEpub('bk_1');
    const reader = result.body.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    await new Promise((r) => setTimeout(r, 150));
    // Generous margin (a quarter of the body) so this can't flake on a fast CI box — but a
    // client that buffered the response whole would be at 32 MiB here.
    expect(written).toBeLessThan(8 * 1024 * 1024);

    let total = first.done ? 0 : first.value.byteLength;
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      total += r.value.byteLength;
    }
    expect(total).toBe(TOTAL);
  });
});

describe('NarratorrStreamClient — non-2xx mapping', () => {
  const envelopeServer = (status: number, code: string) =>
    startServer((_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(errorBody(code, `upstream says ${code}`)));
    });

  it.each([
    [404, 'companion_epub_unavailable'],
    [409, 'companion_epub_disabled'],
    [503, 'companion_epub_busy'],
    [400, 'BAD_REQUEST'],
    [401, 'UNAUTHORIZED'],
  ])('carries a %d envelope code VERBATIM (%s)', async (status, code) => {
    const s = await envelopeServer(status, code);
    const err = await rejection(clientFor(s).openCompanionEpub('bk_1'));
    expect(err).toBeInstanceOf(NarratorrError);
    // The lowercase companion codes are frozen contract — normalizing the casing breaks the
    // proxy route's mapping table.
    expect(err).toMatchObject({ upstreamStatus: status, upstreamCode: code });
  });

  it('falls back to HTTP_<status> for a non-envelope JSON body', async () => {
    const s = await startServer((_req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ oops: true }));
    });
    await expect(clientFor(s).openCompanionEpub('bk_1')).rejects.toMatchObject({
      upstreamStatus: 500,
      upstreamCode: 'HTTP_500',
    });
  });

  it.each([500, 404])('maps an EMPTY %d body to NON_JSON, not HTTP_<status>', async (status) => {
    // An empty body is a non-JSON body. `HTTP_<status>` is reserved for a body we parsed and
    // found the wrong shape, so a bodiless 5xx from a proxy must not masquerade as one.
    const s = await startServer((_req, res) => {
      res.writeHead(status, { 'content-length': '0' });
      res.end();
    });
    const err = await rejection(clientFor(s).openCompanionEpub('bk_1'));
    expect(err).toBeInstanceOf(NarratorrError);
    expect(err).toMatchObject({ upstreamStatus: status, upstreamCode: 'NON_JSON' });
  });

  it('falls back to NON_JSON for an HTML error page', async () => {
    const s = await startServer((_req, res) => {
      res.writeHead(502, { 'content-type': 'text/html' });
      res.end('<html>bad gateway</html>');
    });
    await expect(clientFor(s).openCompanionEpub('bk_1')).rejects.toMatchObject({
      upstreamStatus: 502,
      upstreamCode: 'NON_JSON',
    });
  });

  it('caps a hostile multi-MiB error body instead of buffering it whole', async () => {
    const CHUNK = Buffer.alloc(64 * 1024, 0x41);
    const TOTAL = 8 * 1024 * 1024;
    let written = 0;
    const s = await startServer((_req, res) => {
      res.writeHead(500, { 'content-type': 'text/html' });
      const pump = (): void => {
        while (written < TOTAL) {
          if (res.destroyed) return;
          written += CHUNK.byteLength;
          if (!res.write(CHUNK)) {
            res.once('drain', pump);
            return;
          }
        }
        res.end();
      };
      pump();
    });

    await expect(clientFor(s).openCompanionEpub('bk_1')).rejects.toMatchObject({
      upstreamStatus: 500,
      upstreamCode: 'NON_JSON',
    });
    expect(ERROR_BODY_MAX_BYTES).toBe(64 * 1024);
    expect(written).toBeLessThan(4 * 1024 * 1024);
    await s.whenAborted(); // the upstream body was cancelled, not left open
  });

  it('bounds a SMALL error body that stalls below the cap, and cancels the upstream', async () => {
    // The independent error-body DEADLINE branch: the byte cap can never fire here (the body is
    // ~40 bytes and then hangs forever), so only a timer can end this read.
    const s = await startServer((_req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.write('{"error":{"code":"boom"'); // partial, then stalls forever
    });

    const started = Date.now();
    const err = await rejection(clientFor(s, { errorBodyTimeoutMs: 100 }).openCompanionEpub('bk_1'));
    const elapsed = Date.now() - started;
    expect(err).toBeInstanceOf(NarratorrError);
    expect(err).toMatchObject({ upstreamStatus: 500, upstreamCode: 'NON_JSON' });
    expect(elapsed).toBeLessThan(3000);
    await s.whenAborted();
  });

  it('keeps ABORTED attribution when the caller disconnects DURING the error-body read', async () => {
    // The error-body read is the second place a caller disconnect can land, and it maps every
    // reader failure to "whatever bytes arrived" — so without an explicit re-check the user
    // closing the tab is reported as an upstream 500. #146 branches on that distinction.
    const s = await startServer((_req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.write('{"error":{"code":"boom"'); // partial, then stalls until the caller gives up
    });

    const ac = new AbortController();
    const timers = spyTimers();
    // Generous error-body deadline: only the caller's abort can end this read, so the assertion
    // can't be satisfied by the deadline path the test above already covers. The header deadline
    // is distinctive so the probe below can't match an unrelated timer.
    const pending = clientFor(s, { headerTimeoutMs: 5_000, errorBodyTimeoutMs: 30_000 }).openCompanionEpub(
      'bk_1',
      { signal: ac.signal },
    );
    // Abort STRICTLY after header acquisition: the header timer is cleared the instant `fetch()`
    // resolves, so this pins the abort inside the error-body read rather than letting it land on
    // the (already covered) pre-header path.
    await vi.waitFor(() => expect(timers.headerTimerCleared(5_000)).toBe(true));
    ac.abort();

    const err = await rejection(pending);
    expect(err).toBeInstanceOf(NarratorrError);
    expect(err).toMatchObject({ upstreamStatus: 0, upstreamCode: 'ABORTED' });
    await s.whenAborted();
  });
});

describe('NarratorrStreamClient — request shape hardening', () => {
  it('does NOT follow redirects — the api key is never replayed at an attacker-chosen host', async () => {
    const target = await startServer((_req, res) => {
      res.writeHead(200, { 'content-length': '2' });
      res.end('hi');
    });
    const redirector = await startServer((_req, res) => {
      res.writeHead(302, { location: `${target.baseUrl}/api/v1/books/bk_1/companion-epub` });
      res.end();
    });

    const err = await rejection(clientFor(redirector).openCompanionEpub('bk_1'));
    // The WHATWG cross-origin stripping rule covers `Authorization`, not `X-Api-Key` — so this
    // must surface as our own error, never as a raw fetch TypeError escaping the client.
    expect(err).toBeInstanceOf(NarratorrError);
    expect(err).toMatchObject({ upstreamStatus: 0, upstreamCode: 'NETWORK' });
    // A redirect rejection is a TypeError, never an abort — it keeps the unreachable WORD too.
    expect((err as NarratorrError).message).toMatch(/unreachable$/);
    expect(target.requests).toHaveLength(0);
  });

  it('rejects a 2xx with no body rather than returning an unusable value', async () => {
    const s = await startServer((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    const err = await rejection(clientFor(s).openCompanionEpub('bk_1'));
    expect(err).toBeInstanceOf(NarratorrError);
    expect(err).toMatchObject({ upstreamStatus: 204, upstreamCode: 'NO_BODY' });
  });

  it.each([
    ['../../secret', '/api/v1/books/..%2F..%2Fsecret/companion-epub'],
    ['a b/é', '/api/v1/books/a%20b%2F%C3%A9/companion-epub'],
  ])('percent-encodes publicId %o so it cannot escape the path', async (publicId, expectedPath) => {
    const s = await startServer((_req, res) => {
      res.writeHead(200, { 'content-length': '0' });
      res.end();
    });

    await readAll((await clientFor(s).openCompanionEpub(publicId)).body);
    expect(s.requests[0]?.url).toBe(expectedPath);
  });

  it('normalizes trailing slashes on the base URL', async () => {
    const s = await startServer((_req, res) => {
      res.writeHead(200, { 'content-length': '0' });
      res.end();
    });

    await readAll((await clientFor(`${s.baseUrl}///`).openCompanionEpub('bk_1')).body);
    expect(s.requests[0]?.url).toBe('/api/v1/books/bk_1/companion-epub');
  });
});
