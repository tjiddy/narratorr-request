import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A REAL `node:http` fake narratorr (issue #150) — the upstream half of the cross-app integration
 * harness. It is a real server rather than an MSW handler set on purpose: MSW honors an abort only
 * while a resolver is still pending and re-buffers passthrough bodies, so a mid-body abort behaves
 * IDENTICALLY for correct and broken code under it (curated learning `msw-cannot-test-body-read-abort`).
 *
 * It serves exactly the four upstream endpoints this feature consumes — the same paths the REAL
 * clients build (`narratorr-client.ts` / `narratorr-stream-client.ts`):
 *   • `GET /api/v1/capabilities`
 *   • `GET /api/v1/metadata/search`
 *   • `GET /api/v1/books/:id`
 *   • `GET /api/v1/books/:id/companion-epub`
 *
 * It is deliberately NOT permissive — about credentials (AC1b) or about the METHOD: every request
 * is authenticated against the exact configured key and then required to be a `GET` BEFORE any
 * endpoint handler runs, so a regression that stops sending `X-Api-Key`, or that starts using the
 * wrong verb, fails every scenario instead of passing against a fake that would have served it.
 * Each receipt records the method and whether the presented key matched, so a scenario can assert
 * POSITIVE receipts rather than only the absence of a 401/405.
 *
 * It never answers a 3xx: `NarratorrClient.request()` follows redirects and would replay the api
 * key at the redirect target (open debt #171), so a redirect is not something this fake offers.
 */

/** One observed request. The presented key itself is never retained — only whether it matched. */
export interface FakeNarratorrReceipt {
  method: string;
  /** Path only; the query string is stripped. */
  path: string;
  /** Did the presented `X-Api-Key` equal the configured one? */
  keyMatched: boolean;
}

/** A programmable JSON answer for one of the three JSON endpoints. */
export interface FakeJsonResponse {
  status: number;
  body: unknown;
}

/**
 * What `GET /books/:id/companion-epub` does on the next open.
 *
 * `abort` and `clean-short` are deliberately DIFFERENT shapes, and the difference is the whole
 * point of a real server: `abort` advertises the full length and destroys the socket mid-body
 * (the client must observe a truncation), while `clean-short` advertises the partial length it
 * actually sends and ends cleanly (the client must observe a perfectly ordinary, complete
 * response). Swapping only `destroy()` for `end()` while leaving the longer length advertised is
 * NOT a distinct case — undici enforces the declared length and raises either way.
 */
export type CompanionEpubBehavior =
  | {
      kind: 'body';
      bytes: Uint8Array;
      /** Split the body across writes of this size (default: one write). */
      chunkSize?: number;
      /** Upstream `content-type` (default: the EPUB media type). */
      contentType?: string;
      /** Upstream `content-disposition` — the header our route must NEVER forward. */
      contentDisposition?: string;
    }
  | {
      kind: 'abort';
      /** Advertised `content-length` — the FULL body, so the frame is genuinely broken. */
      bytes: Uint8Array;
      /** Flush this many bytes, then destroy the socket. */
      afterBytes: number;
    }
  | {
      kind: 'clean-short';
      bytes: Uint8Array;
      /** Send (and ADVERTISE) exactly this many bytes, then end cleanly. */
      sendBytes: number;
    }
  | { kind: 'error'; status: number; code: string; message: string };

export interface FakeNarratorr {
  baseUrl: string;
  /** Every request the fake saw, in order — the key-refused ones included. */
  readonly receipts: readonly FakeNarratorrReceipt[];
  /** Companion-EPUB opens ONLY. Capability / search / book traffic is deliberately separate. */
  readonly companionOpens: number;
  /** The receipts whose path ends with `suffix` — the per-endpoint credential receipt (AC1b). */
  receiptsFor(suffix: string): FakeNarratorrReceipt[];
  /** `GET /api/v1/capabilities`. */
  capabilities: FakeJsonResponse;
  /** `GET /api/v1/metadata/search`. */
  search: FakeJsonResponse;
  /** `GET /api/v1/books/:id`, by id. An id with no entry answers a 404 envelope. */
  books: Map<string, FakeJsonResponse>;
  /** `GET /api/v1/books/:id/companion-epub`. */
  companionEpub: CompanionEpubBehavior;
  close(): Promise<void>;
}

const EPUB_MEDIA_TYPE = 'application/epub+zip';

/** narratorr's own error envelope shape (`v1/common.ts`). */
function envelope(code: string, message: string): string {
  return JSON.stringify({ error: { code, message } });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) });
  res.end(payload);
}

/**
 * Write `bytes` in `chunkSize` pieces, honoring backpressure. `onWritten` decides when to stop
 * early — that is how the mid-body abort is expressed without a second pump.
 */
function pump(res: ServerResponse, bytes: Uint8Array, chunkSize: number, stopAfter: number, destroy: boolean): void {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let written = 0;
  const step = (): void => {
    if (written >= stopAfter) {
      if (destroy) res.socket?.destroy();
      else res.end();
      return;
    }
    const size = Math.min(chunkSize, stopAfter - written);
    const slice = buf.subarray(written, written + size);
    written += size;
    if (res.write(slice)) setImmediate(step);
    else res.once('drain', step);
  };
  step();
}

function serveCompanion(res: ServerResponse, behavior: CompanionEpubBehavior): void {
  if (behavior.kind === 'error') {
    const payload = envelope(behavior.code, behavior.message);
    res.writeHead(behavior.status, {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(payload)),
    });
    res.end(payload);
    return;
  }
  if (behavior.kind === 'clean-short') {
    // An ACCURATE length for the partial body, then a clean EOF — a genuinely complete response
    // that merely carries fewer bytes than the caller expected. The control for AC17.
    res.writeHead(200, {
      'content-type': EPUB_MEDIA_TYPE,
      'content-length': String(behavior.sendBytes),
    });
    pump(res, behavior.bytes, behavior.sendBytes, behavior.sendBytes, false);
    return;
  }
  if (behavior.kind === 'abort') {
    // The FULL length is advertised and never delivered: the frame is broken and the socket dies.
    res.writeHead(200, {
      'content-type': EPUB_MEDIA_TYPE,
      'content-length': String(behavior.bytes.byteLength),
    });
    pump(res, behavior.bytes, Math.max(1, behavior.afterBytes), behavior.afterBytes, true);
    return;
  }
  res.writeHead(200, {
    'content-type': behavior.contentType ?? EPUB_MEDIA_TYPE,
    'content-length': String(behavior.bytes.byteLength),
    ...(behavior.contentDisposition !== undefined && { 'content-disposition': behavior.contentDisposition }),
  });
  pump(res, behavior.bytes, behavior.chunkSize ?? Math.max(1, behavior.bytes.byteLength), behavior.bytes.byteLength, false);
}

/**
 * Start the fake on `127.0.0.1:0`. `apiKey` is the EXACT key every request must present.
 */
export async function startFakeNarratorr(opts: { apiKey: string }): Promise<FakeNarratorr> {
  const receipts: FakeNarratorrReceipt[] = [];
  let companionOpens = 0;

  const state: {
    capabilities: FakeJsonResponse;
    search: FakeJsonResponse;
    books: Map<string, FakeJsonResponse>;
    companionEpub: CompanionEpubBehavior;
  } = {
    capabilities: { status: 200, body: { companionEpub: { enabled: true } } },
    search: { status: 200, body: { data: [], total: 0 } },
    books: new Map(),
    companionEpub: { kind: 'body', bytes: new Uint8Array(0) },
  };

  const server = createServer((req, res) => {
    // A client that walks away mid-response makes the socket error (EPIPE/ECONNRESET) — swallow it
    // so a hardening scenario cannot take the worker down with an unhandled 'error'.
    res.on('error', () => {});
    req.on('error', () => {});

    const path = (req.url ?? '').split('?')[0] ?? '';
    const presented = req.headers['x-api-key'];
    const keyMatched = presented === opts.apiKey;
    receipts.push({ method: req.method ?? '', path, keyMatched });

    // AC1b: the credential check runs BEFORE any endpoint handler and echoes NEITHER the presented
    // nor the expected key.
    if (!keyMatched) {
      sendJson(res, 401, { error: { code: 'UNAUTHORIZED', message: 'a valid api key is required' } });
      return;
    }

    // All four endpoints this feature consumes are GETs, and the fake is no more permissive about
    // the METHOD than it is about the key: a client that regressed to another verb must fail here
    // rather than be served a success the real narratorr would never give it. Ordered after the
    // credential check so an unauthenticated caller still learns nothing but `401`.
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'only GET is served here' } });
      return;
    }

    if (path === '/api/v1/capabilities') {
      sendJson(res, state.capabilities.status, state.capabilities.body);
      return;
    }
    if (path === '/api/v1/metadata/search') {
      sendJson(res, state.search.status, state.search.body);
      return;
    }
    const companion = /^\/api\/v1\/books\/([^/]+)\/companion-epub$/u.exec(path);
    if (companion) {
      companionOpens += 1;
      serveCompanion(res, state.companionEpub);
      return;
    }
    const book = /^\/api\/v1\/books\/([^/]+)$/u.exec(path);
    if (book) {
      const answer = state.books.get(decodeURIComponent(book[1] ?? ''));
      if (answer) sendJson(res, answer.status, answer.body);
      else sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'no such book' } });
      return;
    }
    sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'no such route' } });
  });
  server.on('clientError', (_err, socket) => socket.destroy());

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    receipts,
    get companionOpens() {
      return companionOpens;
    },
    receiptsFor: (suffix) => receipts.filter((r) => r.path.endsWith(suffix)),
    get capabilities() {
      return state.capabilities;
    },
    set capabilities(v: FakeJsonResponse) {
      state.capabilities = v;
    },
    get search() {
      return state.search;
    },
    set search(v: FakeJsonResponse) {
      state.search = v;
    },
    get books() {
      return state.books;
    },
    get companionEpub() {
      return state.companionEpub;
    },
    set companionEpub(v: CompanionEpubBehavior) {
      state.companionEpub = v;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
