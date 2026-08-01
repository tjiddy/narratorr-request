import { classifyErrorBody, classifyTransportFailure, NarratorrError } from './narratorr-client.js';

/**
 * Header-acquisition deadline. Covers ONLY the response headers — see
 * {@link NarratorrStreamClient.openCompanionEpub} for why the body deliberately has none.
 */
export const DEFAULT_STREAM_HEADER_TIMEOUT_MS = 15_000;
/** Deadline for reading a non-2xx error body, so a hostile upstream can't hang the call. */
export const DEFAULT_ERROR_BODY_TIMEOUT_MS = 5_000;
/** Hard cap on the bytes we buffer from a non-2xx body before giving up on parsing it. */
export const ERROR_BODY_MAX_BYTES = 64 * 1024;

export interface NarratorrStreamClientConfig {
  baseUrl: string;
  apiKey: string;
  /** Header-acquisition deadline (ms). Defaults to {@link DEFAULT_STREAM_HEADER_TIMEOUT_MS}. */
  headerTimeoutMs?: number;
  /** Non-2xx error-body read deadline (ms). Defaults to {@link DEFAULT_ERROR_BODY_TIMEOUT_MS}. */
  errorBodyTimeoutMs?: number;
}

/**
 * A BOUNDED, allowlisted view of an upstream companion-ebook response — deliberately not a
 * `Response`, not `Headers`, and with no reachable upstream URL or api key. Every upstream header
 * other than the two below is dropped, `content-disposition` INCLUDED: the proxy route
 * synthesizes its own filename from the book title, never from anything narratorr sends.
 */
export interface NarratorrEbookStream {
  /** Upstream `content-type`, verbatim, or null when absent. */
  readonly contentType: string | null;
  /** Parsed `content-length`; null when absent, unparseable or negative. `0` stays `0`. */
  readonly contentLength: number | null;
  /** The LIVE upstream body. Never buffered; backpressure reaches the upstream socket. */
  readonly body: ReadableStream<Uint8Array>;
}

/**
 * Parse an upstream `Content-Length`. Exported because the garbage cases can't be driven over a
 * real socket — undici/llhttp rejects a malformed length at the protocol layer — so this is the
 * unit that decides them.
 *
 * `0` must survive as `0`: the contract explicitly round-trips `sizeBytes: 0`, so a
 * `Number(h) || null` coercion would report "length unknown" for a legitimate empty companion.
 */
export function parseContentLength(raw: string | null): number | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) ? n : null;
}

/** The caller-disconnect outcome. One builder, so both places it can land agree on the wording. */
function abortedError(path: string): NarratorrError {
  return new NarratorrError(0, 'ABORTED', `Narratorr GET ${path} aborted by the caller`);
}

/** Join the collected error-body chunks, truncating at the cap. */
function concatCapped(chunks: Uint8Array[], cap: number): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(Math.min(total, cap));
  let offset = 0;
  for (const c of chunks) {
    if (offset >= out.byteLength) break;
    const slice = c.subarray(0, out.byteLength - offset);
    out.set(slice, offset);
    offset += slice.byteLength;
  }
  return out;
}

/**
 * Raw-byte client for narratorr's companion-ebook endpoint — a SEPARATE class from
 * `NarratorrClient` on purpose. The JSON client wraps `fetch()` AND `res.text()` in one 15s
 * timer, which is right for a small JSON round-trip and unusable for a 25 MiB EPUB; keeping the
 * two apart leaves those semantics untouched and keeps `INarratorrClient` un-widened (a widened
 * shared `Pick<>` structurally breaks every test fake — issue #166).
 *
 * The guarantees this class exists to provide, all of which the proxy route (#146) builds on:
 *   • ONE bounded timer, over header acquisition only — after headers there is NO deadline, so a
 *     body that takes minutes completes.
 *   • The body is the live `ReadableStream`, never buffered, so backpressure reaches the socket.
 *   • The caller's signal (a downstream consumer disconnecting) aborts the UPSTREAM request,
 *     mid-body included — composed with the header controller so it stays live after the timer
 *     is cleared.
 *   • A mid-body upstream failure ERRORS the stream. It never degrades to a clean end, which is
 *     what lets the proxy destroy the downstream socket instead of ending it.
 *   • Redirects are NOT followed: the WHATWG cross-origin stripping rule covers `Authorization`,
 *     not our custom `X-Api-Key`, so a followed redirect would replay the key at a host the
 *     upstream chose.
 */
export class NarratorrStreamClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly headerTimeoutMs: number;
  private readonly errorBodyTimeoutMs: number;

  constructor(cfg: NarratorrStreamClientConfig) {
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, '');
    this.apiKey = cfg.apiKey;
    this.headerTimeoutMs = cfg.headerTimeoutMs ?? DEFAULT_STREAM_HEADER_TIMEOUT_MS;
    this.errorBodyTimeoutMs = cfg.errorBodyTimeoutMs ?? DEFAULT_ERROR_BODY_TIMEOUT_MS;
  }

  /**
   * Open the companion EPUB byte stream for a narratorr book. Resolves once the HEADERS land;
   * the body is still arriving.
   *
   * `opts.signal` is the downstream consumer's disconnect. It is composed with the header-timeout
   * controller via `AbortSignal.any` (Node ≥ 24.10) and handed to `fetch`, so clearing the header
   * timer on success leaves the caller's abort armed for the whole body.
   */
  async openCompanionEpub(publicId: string, opts: { signal?: AbortSignal } = {}): Promise<NarratorrEbookStream> {
    const path = `/api/v1/books/${encodeURIComponent(publicId)}/companion-epub`;
    const headerController = new AbortController();
    let headerTimedOut = false;
    const timer = setTimeout(() => {
      headerTimedOut = true;
      headerController.abort();
    }, this.headerTimeoutMs);
    const signal = opts.signal
      ? AbortSignal.any([opts.signal, headerController.signal])
      : headerController.signal;

    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, {
        method: 'GET',
        signal,
        // A 3xx must surface as OUR error rather than replaying the api key at the redirect
        // target. `redirect: 'error'` rejects the fetch, which the catch below classifies.
        redirect: 'error',
        headers: { 'X-Api-Key': this.apiKey },
      });
    } catch (err: unknown) {
      // Attribution matters to the proxy route: "the user closed the tab" and "narratorr is
      // dead" are the same AbortError here but very different log lines. The caller's signal
      // wins — a composed abort we did not schedule is theirs.
      if (opts.signal?.aborted) throw abortedError(path);
      // Our OWN header timer fired the abort, and it surfaces as an `AbortError` — this predicate
      // is the only part of the classification specific to THIS client (the JSON client has no
      // caller signal to disambiguate, so its predicate is the `headerTimedOut`-free version).
      // What the boolean MEANS is the SHARED decision `NarratorrClient` applies too (#173).
      throw classifyTransportFailure(
        `Narratorr GET ${path}`,
        headerTimedOut && err instanceof Error && err.name === 'AbortError',
      );
    } finally {
      // Cleared on BOTH paths — a leaked timer is an open handle aimed at nothing.
      clearTimeout(timer);
    }

    // The error-body read is a SECOND place the caller's disconnect can land (a stalled non-2xx
    // body is exactly the case the bounded read exists for), and `readBoundedErrorBody` maps every
    // reader failure to "whatever bytes arrived". Re-check the caller signal around it so an
    // abort keeps its attribution instead of being reported as an upstream failure.
    if (!res.ok) {
      const err = await this.errorFor(path, res);
      throw opts.signal?.aborted ? abortedError(path) : err;
    }

    // A 2xx with no body (204/205/304) can't be proxied; returning an unusable value would push
    // the failure into the route's stream plumbing instead of its error path.
    if (!res.body) {
      throw new NarratorrError(res.status, 'NO_BODY', `Narratorr GET ${path} returned no body`);
    }

    return {
      contentType: res.headers.get('content-type'),
      contentLength: parseContentLength(res.headers.get('content-length')),
      body: res.body,
    };
  }

  /**
   * Map a non-2xx response to a `NarratorrError`, reading its body under BOTH a byte cap and a
   * deadline so a hostile or wedged upstream can neither be buffered whole nor hang the call.
   * The body is always cancelled afterwards rather than left open.
   */
  private async errorFor(path: string, res: Response): Promise<NarratorrError> {
    const text = await this.readBoundedErrorBody(res);
    // The bounded read is this class's own concern; what the resulting text MEANS is the SHARED
    // decision `NarratorrClient` applies too (issue #171/#173) — the two clients now agree on
    // empty vs malformed vs non-envelope, and only the message prefix differs by endpoint.
    return classifyErrorBody(`Narratorr GET ${path}`, res.status, text);
  }

  private async readBoundedErrorBody(res: Response): Promise<string> {
    const body = res.body;
    if (!body) return '';
    const reader = body.getReader();

    // The deadline is RACED against each read rather than only cancelling the reader: a stalled
    // body below the byte cap must still end the call promptly, whatever a given runtime does
    // with reads already pending when a stream is cancelled.
    let expire!: () => void;
    const expired = new Promise<'expired'>((resolve) => {
      expire = () => resolve('expired');
    });
    const timer = setTimeout(expire, this.errorBodyTimeoutMs);

    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const next = await Promise.race([reader.read(), expired]);
        if (next === 'expired' || next.done) break;
        if (next.value.byteLength > 0) {
          chunks.push(next.value);
          total += next.value.byteLength;
        }
        if (total >= ERROR_BODY_MAX_BYTES) break;
      }
    } catch {
      // A failed/aborted error-body read still yields whatever arrived — the STATUS is what the
      // mapping keys on, so a partial body degrades to NON_JSON rather than masking the status.
    } finally {
      clearTimeout(timer);
      void reader.cancel().catch(() => {});
    }
    return new TextDecoder().decode(concatCapped(chunks, ERROR_BODY_MAX_BYTES));
  }
}

/**
 * The proxy route's per-consumer slice (issue #166: never widen the shared `INarratorrClient`
 * `Pick<>` — it structurally forces the new method onto every fake that never calls it).
 */
export type IEbookStreamClient = Pick<NarratorrStreamClient, 'openCompanionEpub'>;
