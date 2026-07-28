import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildRouteApp, type RouteHarness } from '../test-support/route-harness.js';
import { insertUser } from '../test-support/db.js';
import { registerEbookRoutes } from './ebooks.js';
import { NarratorrStreamClient, type IEbookStreamClient, type NarratorrEbookStream } from '../services/narratorr-stream-client.js';
import { expectNoLeaks as sweepForLeaks } from '../test-support/leak-sentinels.js';

// ---------------------------------------------------------------------------
// REAL sockets end to end: a real `node:http` fake narratorr, a real `app.listen(0)`, a real
// `fetch` client. NO MSW is registered in this file — deliberately. MSW honors an abort only while
// a resolver is still pending and re-buffers passthrough bodies, so mid-body abort, truncation and
// backpressure all behave IDENTICALLY for correct and broken code under it (curated learning
// `msw-cannot-test-body-read-abort`, #95/#109). Everything that does not need a real socket lives
// in `ebooks.route.test.ts`.
// ---------------------------------------------------------------------------

const API_KEY = 'sk-leak-sentinel-key';
const GOOD_ID = 'bk_abc123';

interface FakeServer {
  baseUrl: string;
  requests: Array<{ method: string; url: string }>;
  /** Companion-epub opens only — the capability probe is separate traffic (AC8, AC26 rule 1). */
  companionRequests(): number;
  /** How many responses the CLIENT cut short (socket closed before the response finished). */
  readonly aborted: number;
  whenAborted(): Promise<void>;
  close(): Promise<void>;
}

type Defer = (ms: number, fn: () => void) => void;

const openServers: FakeServer[] = [];

async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse, defer: Defer) => void,
): Promise<FakeServer> {
  const requests: Array<{ method: string; url: string }> = [];
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  const defer: Defer = (ms, fn) => {
    timers.push(setTimeout(fn, ms));
  };
  let aborted = 0;
  let notify: (() => void) | null = null;

  const server = createServer((req, res) => {
    requests.push({ method: req.method ?? '', url: req.url ?? '' });
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
    companionRequests: () => requests.filter((r) => r.url.endsWith('/companion-epub')).length,
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

// ---------------------------------------------------------------------------
// The app under test: the real route, wired to whichever stream client the case needs, listening
// on an ephemeral port. `sent` counts OUTBOUND responses and `errored` counts entries into the
// central error path — the two properties that distinguish AC26's "return silently" seam rule from
// a mere upstream-open guard.
// ---------------------------------------------------------------------------
interface AppUnderTest {
  h: RouteHarness;
  origin: string;
  cookie: string;
  sent: number;
  errored: number;
  /**
   * Upstream open ATTEMPTS, counted synchronously on entry. Deliberately not the fake server's
   * request log: an absence assertion against the network would also pass while the request was
   * merely still in flight, whereas this flips the instant the handler decides to open.
   */
  opens: number;
  /**
   * How many in-flight responses the SERVER has observed closing. The disconnect placements park
   * the handler and then abort; without waiting for this the test would release the barrier before
   * the close event had been processed, so `clientGone` would legitimately still read false and
   * the case would prove nothing about the seams.
   */
  closed: number;
  logErrors: () => number;
}

/** Counts open attempts the moment the handler makes them, then delegates. */
class CountingStreamClient implements IEbookStreamClient {
  attempts = 0;
  constructor(private readonly inner: IEbookStreamClient) {}
  openCompanionEpub(publicId: string, opts?: { signal?: AbortSignal }): Promise<NarratorrEbookStream> {
    this.attempts += 1;
    return this.inner.openCompanionEpub(publicId, opts);
  }
}

/**
 * Let a parked handler resume and run to COMPLETION before asserting an absence. `vi.waitFor` is
 * the wrong tool for "nothing happened" — its callback passes on the first try, so it returns
 * before the handler has even woken up and the assertion is vacuous.
 */
const settle = (ms = 150): Promise<void> => new Promise((r) => setTimeout(r, ms));

let app: AppUnderTest | null = null;
let unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);

beforeEach(() => {
  unhandled = [];
  process.on('unhandledRejection', onUnhandled);
});

afterEach(async () => {
  process.off('unhandledRejection', onUnhandled);
  // A test that leaves a response mid-stream would otherwise wedge `close()` waiting on the
  // socket; the streaming cases are the ones most likely to fail that way.
  app?.h.app.server.closeAllConnections();
  await app?.h.app.close();
  app = null;
  await Promise.all(openServers.splice(0).map((s) => s.close()));
  vi.restoreAllMocks();
});

async function startApp(opts: { ebookStream: IEbookStreamClient; ebooksEnabled?: boolean }): Promise<AppUnderTest> {
  const counters = { sent: 0, errored: 0, closed: 0 };
  const counting = new CountingStreamClient(opts.ebookStream);
  const h = await buildRouteApp({
    ebookStream: counting,
    register: (a: FastifyInstance, deps) => {
      a.addHook('onSend', async () => {
        counters.sent += 1;
      });
      a.addHook('onError', async () => {
        counters.errored += 1;
      });
      registerEbookRoutes(a, deps);
    },
  });
  h.narratorr.companionEpub = true;
  await h.connectorSettings.update({ ebooksEnabled: opts.ebooksEnabled ?? true });
  const logError = vi.spyOn(h.app.log, 'error');
  await h.app.listen({ port: 0, host: '127.0.0.1' });
  // A second 'request' listener on the raw server, so the close observer is installed at the
  // earliest possible moment — before any Fastify hook has run, which is the whole point for the
  // auth-hook placement.
  h.app.server.on('request', (_req, res) => {
    res.on('close', () => {
      if (!res.writableFinished) counters.closed += 1;
    });
  });
  const { port } = h.app.server.address() as AddressInfo;
  const user = await insertUser(h.db, { role: 'user', status: 'active' });
  const token = h.cookieFor(user).nreq_session;

  app = {
    h,
    origin: `http://127.0.0.1:${port}`,
    cookie: `nreq_session=${token}`,
    get sent() {
      return counters.sent;
    },
    get errored() {
      return counters.errored;
    },
    get opens() {
      return counting.attempts;
    },
    get closed() {
      return counters.closed;
    },
    logErrors: () => logError.mock.calls.length,
  };
  return app;
}

/** A real HTTP GET at the running app. */
function get(a: AppUnderTest, bookId = GOOD_ID, query = '', init: RequestInit = {}): Promise<Response> {
  return fetch(`${a.origin}/api/ebooks/${bookId}/download${query}`, {
    ...init,
    headers: { cookie: a.cookie, ...(init.headers ?? {}) },
  });
}

/** A stream client pointed at the fake narratorr — the genuine client, over a genuine socket. */
const realClient = (fake: FakeServer) => new NarratorrStreamClient({ baseUrl: fake.baseUrl, apiKey: API_KEY });

/** Drain a fetch body, returning the bytes read; rejects if the transfer errors (which several cases want). */
async function drain(res: Response): Promise<Uint8Array> {
  const reader = res.body!.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    chunks.push(r.value);
    total += r.value.byteLength;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

const rejection = (p: Promise<unknown>): Promise<unknown> => p.then(() => null).catch((e: unknown) => e);

/** A promise plus its resolver — the barrier several disconnect placements are built on. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

describe('streaming and backpressure over a real socket (AC10, F24)', () => {
  it('delivers the first bytes before the upstream body completes, byte-identically', async () => {
    const CHUNK = 64 * 1024;
    const COUNT = 512; // 32 MiB
    const TOTAL = CHUNK * COUNT;
    let written = 0;
    const fake = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/epub+zip', 'content-length': String(TOTAL) });
      const pump = (): void => {
        while (written < TOTAL) {
          const seq = written / CHUNK;
          if (!res.write(Buffer.alloc(CHUNK, seq % 251))) {
            written += CHUNK;
            res.once('drain', pump);
            return;
          }
          written += CHUNK;
        }
        res.end();
      };
      pump();
    });
    const a = await startApp({ ebookStream: realClient(fake) });

    const res = await get(a);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe(String(TOTAL));

    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);

    // F24, asserted as a STALL rather than as a byte threshold: three hops of pipeline buffering
    // (fake -> undici, undici -> our wrapper, our response -> client socket) make any absolute
    // margin a guess, but the property is exact — with nobody reading downstream, the producer
    // must come to a complete stop, and it must do so BEFORE the body is finished. Polling for
    // that rest (rather than sampling at a fixed instant) is what keeps it honest under a loaded
    // suite, where the buffers can still be filling well past any hard-coded delay.
    let previous = -1;
    let parked = written;
    for (let i = 0; i < 40 && parked !== previous; i += 1) {
      previous = parked;
      await new Promise((r) => setTimeout(r, 50));
      parked = written;
    }
    expect(parked, 'the upstream producer never came to rest while the consumer was paused').toBe(previous);
    // ...and it came to rest SHORT of the whole body. A wrapper that eagerly drained the upstream
    // into memory would also be "at rest" here — at 32 MiB.
    expect(parked).toBeLessThan(TOTAL);

    let total = first.value!.byteLength;
    const seen = [first.value!];
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      total += r.value.byteLength;
      seen.push(r.value);
    }
    expect(total).toBe(TOTAL);
    // Byte identity, not just length: the payload is a repeating per-chunk marker, so a reordered
    // or duplicated chunk shows up here.
    const joined = new Uint8Array(total);
    let off = 0;
    for (const c of seen) {
      joined.set(c, off);
      off += c.byteLength;
    }
    for (let seq = 0; seq < COUNT; seq += 1) {
      expect(joined[seq * CHUNK]).toBe(seq % 251);
      expect(joined[seq * CHUNK + CHUNK - 1]).toBe(seq % 251);
    }
  });
});

describe('truncation safety over a real socket (AC24, AC25, F23)', () => {
  it('destroys OUR response when the upstream dies mid-body — never a clean short body', async () => {
    const DECLARED = 4096;
    const fake = await startServer((_req, res, defer) => {
      res.writeHead(200, { 'content-type': 'application/epub+zip', 'content-length': String(DECLARED) });
      res.write(Buffer.alloc(512, 5));
      defer(30, () => res.destroy());
    });
    const a = await startApp({ ebookStream: realClient(fake) });

    const res = await get(a, GOOD_ID, '?title=Dune');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="Dune.epub"');

    const err = await rejection(drain(res));
    // An EXCEPTION, never a clean end: the browser reports a failed download instead of saving a
    // truncated file that looks complete.
    expect(err).toBeInstanceOf(Error);
  });

  it('502s a first-read failure with the full JSON envelope and no success-only headers', async () => {
    // F23: the fake advertises a POSITIVE content-length before destroying, so a close-delimited
    // zero-byte 200 (which AC36 requires us to ACCEPT) cannot make this pass vacuously.
    const fake = await startServer((_req, res, defer) => {
      res.writeHead(200, { 'content-type': 'application/epub+zip', 'content-length': '5000' });
      defer(20, () => res.destroy());
    });
    const a = await startApp({ ebookStream: realClient(fake) });

    const res = await get(a, GOOD_ID, '?title=Dune');
    expect(res.status).toBe(502);
    const body = await res.text();
    expect(JSON.parse(body).error.code).toBe('NARRATORR_UNAVAILABLE');
    expect(res.headers.get('content-disposition')).toBeNull();
    expect(res.headers.get('cache-control')).not.toBe('private, no-store');
    expect(res.headers.get('content-length')).toBe(String(Buffer.byteLength(body)));
    expectNoLeaks(res, body, 'real-socket first-read failure');
  });
});

describe('header allowlist against a hostile narratorr (AC15, AC32, AC38)', () => {
  it('forwards only the content-type decision and the parsed content-length', async () => {
    const payload = Buffer.from('EPUBBYTES');
    const fake = await startServer((_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/epub+zip',
        'content-length': String(payload.byteLength),
        'content-disposition': 'attachment; filename="upstream-chosen-name.epub"',
        'set-cookie': 'sid=abc; Path=/',
        etag: 'W/"upstream"',
        'last-modified': 'Wed, 21 Oct 2015 07:28:00 GMT',
        'accept-ranges': 'bytes',
        'x-api-key': API_KEY,
        'x-narratorr-media': '/var/lib/narratorr/media/Secret.epub',
        'x-narratorr-media-win': 'C:\\narratorr\\media\\Secret.epub',
        'x-narratorr-media-unc': '\\\\host\\share\\Secret.epub',
        'x-narratorr-origin': 'http://narratorr.internal:8123/api/v1',
      });
      res.end(payload);
    });
    const a = await startApp({ ebookStream: realClient(fake) });

    const res = await get(a, GOOD_ID, '?title=Dune');
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toBe('EPUBBYTES');

    // Our synthesized name wins; nothing else upstream sent survives.
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="Dune.epub"');
    for (const header of ['set-cookie', 'etag', 'last-modified', 'accept-ranges', 'x-api-key', 'x-narratorr-media', 'x-narratorr-origin']) {
      expect(res.headers.get(header), `${header} must not be forwarded`).toBeNull();
    }
    expectNoLeaks(res, body, 'hostile upstream headers');
  });
});

describe('caller disconnect (AC26, AC27)', () => {
  it('tears the upstream down when the client walks away mid-download', async () => {
    const fake = await startServer((_req, res, defer) => {
      res.writeHead(200, { 'content-type': 'application/epub+zip' });
      const pump = (): void => {
        if (res.writableEnded || res.destroyed) return;
        res.write(Buffer.alloc(16 * 1024, 3));
        defer(20, pump);
      };
      pump();
    });
    const a = await startApp({ ebookStream: realClient(fake) });

    const ac = new AbortController();
    const res = await get(a, GOOD_ID, '', { signal: ac.signal });
    const reader = res.body!.getReader();
    expect((await reader.read()).done).toBe(false);

    ac.abort();
    await rejection(reader.read());
    await fake.whenAborted();
    expect(fake.aborted).toBeGreaterThanOrEqual(1);
    expect(unhandled).toEqual([]);
  });

  it('aborts an in-flight upstream fetch during the HEADER phase (F10)', async () => {
    // The fake accepts the request and then withholds its response headers forever. Only a signal
    // that actually reached the in-flight `fetch()` can end this — an AbortController created
    // after `openCompanionEpub` resolved would leave the header wait unabortable.
    const fake = await startServer(() => {
      /* headers deliberately never written */
    });
    const a = await startApp({ ebookStream: realClient(fake) });

    const ac = new AbortController();
    const pending = rejection(get(a, GOOD_ID, '', { signal: ac.signal }));
    await vi.waitFor(() => expect(fake.companionRequests()).toBe(1));
    ac.abort();

    expect(await pending).toBeInstanceOf(Error); // the DOWNSTREAM fetch is what rejects
    await fake.whenAborted();
    expect(fake.aborted).toBe(1);
    await settle();
    expect(a.sent).toBe(0);
    expect(a.errored).toBe(0);
    expect(unhandled).toEqual([]);
  });
});

describe('disconnect placements — PRE-OPEN: no companion-epub request at all (AC26 rule 1)', () => {
  it('during a slow feature resolver inside the handler', async () => {
    const fake = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/epub+zip', 'content-length': '3' });
      res.end('abc');
    });
    const a = await startApp({ ebookStream: realClient(fake) });

    const held = gate();
    const reached = gate();
    const real = a.h.connectorSettings.getEbookSettings.bind(a.h.connectorSettings);
    vi.spyOn(a.h.connectorSettings, 'getEbookSettings').mockImplementation(async () => {
      reached.open();
      await held.wait;
      return real();
    });

    const ac = new AbortController();
    const pending = rejection(get(a, GOOD_ID, '', { signal: ac.signal }));
    await reached.wait;
    ac.abort();
    await pending;
    await vi.waitFor(() => expect(a.closed).toBe(1));
    held.open();

    // The handler resumes, finds the caller gone, and must never open the stream.
    await settle();
    expect(a.opens).toBe(0);
    expect(fake.companionRequests()).toBe(0);
    expect(a.sent).toBe(0);
    expect(a.errored).toBe(0);
    expect(a.logErrors()).toBe(0);
    expect(unhandled).toEqual([]);
  });

  it('during a slow auth hook, BEFORE the handler exists', async () => {
    // The case no listener placement inside the handler can catch: `close` fires while
    // `authPlugin`'s onRequest hook is still awaiting `users.getById`, so only AC26's
    // initialize-from-current-state rule stops the open.
    const fake = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/epub+zip', 'content-length': '3' });
      res.end('abc');
    });
    const a = await startApp({ ebookStream: realClient(fake) });

    const held = gate();
    const reached = gate();
    const real = a.h.users.getById.bind(a.h.users);
    vi.spyOn(a.h.users, 'getById').mockImplementation(async (id: number) => {
      reached.open();
      await held.wait;
      return real(id);
    });

    const ac = new AbortController();
    const pending = rejection(get(a, GOOD_ID, '', { signal: ac.signal }));
    await reached.wait;
    ac.abort();
    await pending;
    await vi.waitFor(() => expect(a.closed).toBe(1));
    held.open();

    await settle();
    expect(a.opens).toBe(0);
    expect(fake.companionRequests()).toBe(0);
    expect(a.sent).toBe(0);
    expect(a.errored).toBe(0);
    expect(unhandled).toEqual([]);
  });
});

describe('disconnect placements — POST-OPEN, PRE-COMMIT: exactly one request, no response (AC26)', () => {
  it('cancels the upstream when the abort lands while the first read is still pending', async () => {
    // Placement 3: the fake holds its first body byte, the client aborts, then the byte is
    // released. The raw stream client errors an in-flight body read on abort, so this exercises
    // the CANCELLATION / error seam — see the success-seam case below for the other half.
    const release = gate();
    const fake = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/epub+zip' });
      // FLUSH the headers with no body byte: that is what makes this post-OPEN (the upstream
      // fetch has resolved) but pre-commit (our peek is still waiting on the first chunk).
      res.flushHeaders();
      void release.wait.then(() => {
        if (!res.destroyed) res.end(Buffer.alloc(8, 1));
      });
    });
    const a = await startApp({ ebookStream: realClient(fake) });

    const ac = new AbortController();
    const pending = rejection(get(a, GOOD_ID, '', { signal: ac.signal }));
    await vi.waitFor(() => expect(fake.companionRequests()).toBe(1));
    ac.abort();
    await pending;

    // Observe the upstream teardown BEFORE releasing the held byte: releasing first would let the
    // fake finish its response in the window before the disconnect propagates, which would make
    // `whenAborted()` (keyed on `!writableFinished`) miss a teardown that really happened.
    await fake.whenAborted();
    release.open();
    await settle();
    expect(a.opens).toBe(1);
    expect(fake.companionRequests()).toBe(1);
    expect(a.sent).toBe(0);
    expect(a.errored).toBe(0);
    expect(a.logErrors()).toBe(0);
    expect(unhandled).toEqual([]);
  });

  it('SUPPRESSES the success commit when the peek resolved fine but the caller is gone (F40)', async () => {
    // The success-seam receipt the abort-before-release case cannot give: here the first read
    // SUCCEEDS (an in-process stub, so the abort does not error it), and only then does the
    // handler evaluate liveness. An implementation whose `respond()` skipped the check would
    // commit headers and write to a dead socket.
    const stub = new HeldFirstReadClient();
    const a = await startApp({ ebookStream: stub });

    const ac = new AbortController();
    const pending = rejection(get(a, GOOD_ID, '', { signal: ac.signal }));
    await vi.waitFor(() => expect(stub.opened).toBe(1));
    ac.abort();
    // Wait until the disconnect has actually reached the handler's controller, THEN let the read
    // succeed — that ordering is what makes the race deterministic.
    await vi.waitFor(() => expect(stub.signal?.aborted).toBe(true));
    stub.releaseFirstRead();
    await pending;

    await vi.waitFor(() => expect(stub.cancelled).toBe(true));
    await settle();
    expect(a.sent).toBe(0);
    expect(a.errored).toBe(0);
    expect(a.logErrors()).toBe(0);
    expect(unhandled).toEqual([]);
  });
});

describe('silent refusal — the RESPONSE half of AC26 rule 2 (AC27)', () => {
  it('does not send the EBOOKS_DISABLED 403 that a slow resolver settles after the disconnect', async () => {
    const fake = await startServer((_req, res) => {
      res.writeHead(200, { 'content-length': '0' });
      res.end();
    });
    const a = await startApp({ ebookStream: realClient(fake) });

    const held = gate();
    const reached = gate();
    vi.spyOn(a.h.connectorSettings, 'getEbookSettings').mockImplementation(async () => {
      reached.open();
      await held.wait;
      return { ebooksEnabled: false, kindleSender: null }; // settles FEATURE-OFF, post-disconnect
    });

    const ac = new AbortController();
    const pending = rejection(get(a, GOOD_ID, '', { signal: ac.signal }));
    await reached.wait;
    ac.abort();
    await pending;
    await vi.waitFor(() => expect(a.closed).toBe(1));
    held.open();

    await settle();
    expect(a.opens).toBe(0);
    expect(fake.companionRequests()).toBe(0);
    expect(a.sent).toBe(0);
    expect(a.errored).toBe(0);
    expect(a.logErrors()).toBe(0);
    expect(unhandled).toEqual([]);
  });

  it.each([
    ['the AC9 invalid-id 404', 'not-a-book'],
    ['a valid id that would have succeeded', GOOD_ID],
  ])('stays silent for %s when the disconnect lands during the auth hook', async (_label, bookId) => {
    const fake = await startServer((_req, res) => {
      res.writeHead(200, { 'content-length': '0' });
      res.end();
    });
    const a = await startApp({ ebookStream: realClient(fake) });

    const held = gate();
    const reached = gate();
    const real = a.h.users.getById.bind(a.h.users);
    vi.spyOn(a.h.users, 'getById').mockImplementation(async (id: number) => {
      reached.open();
      await held.wait;
      return real(id);
    });

    const ac = new AbortController();
    const pending = rejection(get(a, bookId, '', { signal: ac.signal }));
    await reached.wait;
    ac.abort();
    await pending;
    await vi.waitFor(() => expect(a.closed).toBe(1));
    held.open();

    await settle();
    expect(a.sent).toBe(0);
    expect(a.errored).toBe(0);
    expect(a.logErrors()).toBe(0);
    expect(unhandled).toEqual([]);
  });
});

/**
 * An in-process stream client whose FIRST read is held open and then RESOLVES successfully. The
 * genuine client deliberately errors an in-flight body read on abort, which would route the F40
 * case into the error seam; this stub is what isolates the success seam.
 */
class HeldFirstReadClient implements IEbookStreamClient {
  opened = 0;
  cancelled = false;
  signal: AbortSignal | undefined = undefined;
  private release!: () => void;
  private readonly held: Promise<void>;

  constructor() {
    let open!: () => void;
    this.held = new Promise<void>((resolve) => {
      open = resolve;
    });
    this.release = open;
  }

  releaseFirstRead(): void {
    this.release();
  }

  async openCompanionEpub(_publicId: string, opts: { signal?: AbortSignal } = {}): Promise<NarratorrEbookStream> {
    this.opened += 1;
    this.signal = opts.signal;
    const held = this.held;
    const markCancelled = () => {
      this.cancelled = true;
    };
    let first = true;
    return {
      contentType: 'application/epub+zip',
      contentLength: 8,
      body: new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (first) {
            first = false;
            await held;
            controller.enqueue(new Uint8Array([1, 2, 3, 4]));
            return;
          }
          // Deliberately never settles: the stream must still be OPEN when the handler cancels
          // it, or `cancel()` is a no-op on an already-closed stream and the receipt is vacuous.
          await new Promise<void>(() => {});
        },
        cancel: markCancelled,
      }),
    };
  }
}

/** AC32/AC38 over a real response: no sentinel in the body or in ANY header. */
function expectNoLeaks(res: Response, body: string, where: string): void {
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k] = v;
  });
  sweepForLeaks(body, headers, where);
}
