import type { z } from 'zod';
import { v1AudibleSearchSchema, type V1AudibleResult } from '../../shared/schemas/v1/metadata.js';
import { v1BookSchema, type V1Book } from '../../shared/schemas/v1/books.js';
import { v1SystemSchema, type V1System } from '../../shared/schemas/v1/system.js';
import { v1CapabilitiesSchema, type V1Capabilities } from '../../shared/schemas/v1/capabilities.js';
import { errorEnvelopeSchema } from '../../shared/schemas/v1/common.js';
import { ApiError } from '../util/errors.js';

export interface NarratorrClientConfig {
  baseUrl: string;
  apiKey: string;
  /** Per-request timeout (ms). */
  timeoutMs?: number;
}

/**
 * An error talking to Narratorr's `/api/v1`. Always surfaces to OUR clients as a
 * 502 (it's a server-to-server failure), but carries the upstream status/code so
 * callers (e.g. the status poller) can branch — a 404 on a book means it vanished
 * upstream, not that our request was malformed.
 */
export class NarratorrError extends ApiError {
  constructor(
    readonly upstreamStatus: number,
    readonly upstreamCode: string,
    message: string,
    /** Raw upstream JSON body — lets callers read non-envelope fields (e.g. a 409's `existingId`). */
    readonly body?: unknown,
  ) {
    super(502, 'NARRATORR_UPSTREAM', message);
    this.name = 'NarratorrError';
  }
}

/**
 * The ONE non-2xx body → `NarratorrError` decision, shared by `NarratorrClient.request()` and
 * `NarratorrStreamClient.errorFor()`. The two clients acquire the body differently (one plain
 * `res.text()`, one bounded/capped read), but what the resulting text MEANS must not diverge —
 * a second copy of this policy is exactly what issue #173 was filed about.
 *
 * `label` is the caller's message prefix (`Narratorr POST /api/v1/books` vs
 * `Narratorr GET /api/v1/books/:id/companion-epub`). It is the only reason the two clients'
 * messages differ, and that stays deliberate: the endpoint belongs in the message.
 *
 * | `text`                        | `upstreamCode`      | `message`                     |
 * |-------------------------------|---------------------|-------------------------------|
 * | empty                         | `NON_JSON`          | `… returned an empty body`    |
 * | fails `JSON.parse`            | `NON_JSON`          | `… returned non-JSON`         |
 * | parses, is the error envelope | envelope code       | envelope message              |
 * | parses, not an envelope       | `HTTP_${status}`    | `… failed (${status})`        |
 *
 * An EMPTY body is a non-JSON body, not a non-envelope JSON one: `HTTP_<status>` is reserved for
 * a body we successfully parsed and found the wrong shape.
 */
export function classifyErrorBody(label: string, status: number, text: string): NarratorrError {
  if (!text) {
    return new NarratorrError(status, 'NON_JSON', `${label} returned an empty body`);
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return new NarratorrError(status, 'NON_JSON', `${label} returned non-JSON`);
  }

  const parsed = errorEnvelopeSchema.safeParse(json);
  // The companion codes (`companion_epub_unavailable` / `_disabled` / `_busy`) are frozen
  // lowercase contract — pass them through verbatim, never normalized.
  const { code, message } = parsed.success
    ? parsed.data.error
    : { code: `HTTP_${status}`, message: `${label} failed (${status})` };
  // The RAW parsed JSON, never `parsed.data`: `errorEnvelopeSchema` is a plain `z.object`, so
  // Zod strips unknown siblings and `addBook()`'s 409 `existingId` read would go null.
  return new NarratorrError(status, code, message, json);
}

/**
 * The ONE status-0 (transport) `NarratorrError` decision, shared by `NarratorrClient.request()`
 * and `NarratorrStreamClient.openCompanionEpub()` — the sibling of `classifyErrorBody` above, and
 * for the same reason: a second copy of a decision both clients make is exactly what #173 was
 * filed about. Each client keeps its own MECHANISM-specific predicate (their abort controllers
 * differ, and the stream client must let a caller disconnect win first) and hands the resulting
 * boolean here, so the code ↔ message-word pairing has a single owner and cannot drift.
 *
 * | `timedOut` | `upstreamCode` | `message`         |
 * |------------|----------------|-------------------|
 * | `true`     | `TIMEOUT`      | `… timed out`     |
 * | `false`    | `NETWORK`      | `… unreachable`   |
 *
 * `timedOut` MUST be decided structurally at the call site, never from message text (#213). Both
 * callers arm their own `controller.abort()`, which surfaces as an `AbortError`; an
 * `AbortSignal.timeout` would surface as a `TimeoutError` instead, and a `redirect: 'error'`
 * rejection is a `TypeError` that must stay NETWORK.
 */
export function classifyTransportFailure(label: string, timedOut: boolean): NarratorrError {
  return timedOut
    ? new NarratorrError(0, 'TIMEOUT', `${label} timed out`)
    : new NarratorrError(0, 'NETWORK', `${label} unreachable`);
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** Pull `existingId` out of a `POST /books` 409 body (`{ error, existingId }`). */
function readExistingId(body: unknown): string | null {
  const id = (body as { existingId?: unknown } | null)?.existingId;
  return typeof id === 'string' && id ? id : null;
}

/**
 * Typed client over the vendored `/api/v1` contract — three calls: search, add,
 * poll. In standalone mode the same code is intercepted by the MSW handler set
 * (`mocks/narratorr-v1.ts`); in narratorr mode it hits the live API. Responses are
 * parsed through the contract schemas so drift surfaces as a 502 CONTRACT_MISMATCH
 * rather than a silent bad shape leaking into our domain.
 */
export class NarratorrClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(cfg: NarratorrClientConfig) {
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, '');
    this.apiKey = cfg.apiKey;
    this.timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async searchMetadata(q: string): Promise<V1AudibleResult[]> {
    const res = await this.request('GET', '/api/v1/metadata/search', v1AudibleSearchSchema, {
      query: { q },
    });
    return res.data;
  }

  /**
   * The "I want this book" command — add the book by ASIN; returns the (bare) library
   * book. There is no idempotency key: a book that already exists (a lost-response
   * retry, or another user already requested the ASIN) comes back as a 409 carrying
   * `existingId`. That's a success, not a failure — we fetch that book and return it,
   * so callers always get a V1Book and the add is effectively idempotent by ASIN.
   * (Whether narratorr then searches/grabs is its operator's `searchImmediately`
   * setting, not ours.)
   */
  async addBook(asin: string): Promise<V1Book> {
    try {
      return await this.request('POST', '/api/v1/books', v1BookSchema, { body: { asin } });
    } catch (err: unknown) {
      if (err instanceof NarratorrError && err.upstreamStatus === 409) {
        const existingId = readExistingId(err.body);
        if (existingId) return this.getBook(existingId);
      }
      throw err;
    }
  }

  /** Poll a book's lifecycle. A 404 means the publicId no longer resolves upstream. */
  async getBook(publicId: string): Promise<V1Book> {
    return this.request('GET', `/api/v1/books/${encodeURIComponent(publicId)}`, v1BookSchema);
  }

  /**
   * Narratorr's build-info probe (narratorr #1709) — `{ version, commit, buildTime, … }`.
   * Used by the admin System Information card to surface the connected narratorr's version
   * and reachability. We assert only `version`; a body missing it is a CONTRACT_MISMATCH.
   * NOTE: this is the NATIVE `/api/v1/system`, NOT `/api/v1/system/status` (the
   * Prowlarr/Readarr compat shim — the wrong surface).
   */
  async getSystem(): Promise<V1System> {
    return this.request('GET', '/api/v1/system', v1SystemSchema);
  }

  /**
   * Feature discovery (narratorr #1961) — its OWN endpoint, deliberately not a key on
   * `/api/v1/system`. Probed WITH the API key (a keyless probe cannot tell "old narratorr" from
   * "bad key": both answer without the capability body). Contract: a `404` is the ONLY
   * "unsupported" signal; a `401` is an auth problem and never means unsupported; a 200 body
   * missing `companionEpub.enabled` is provider drift → CONTRACT_MISMATCH, which the resolver
   * must treat as transient. Callers branch on `upstreamStatus`, not the code string —
   * a Fastify JSON 404 yields `HTTP_404` while a reverse-proxy HTML 404 page yields `NON_JSON`.
   */
  async getCapabilities(): Promise<V1Capabilities> {
    return this.request('GET', '/api/v1/capabilities', v1CapabilitiesSchema);
  }

  /**
   * Connectivity probe for the Settings "Test" button. A bogus book id that returns a
   * structured 404 proves the URL is reachable AND the API key authenticated — so we
   * treat a 404 as success and let any other error (network, 401/403, contract) surface.
   */
  async ping(): Promise<void> {
    try {
      await this.getBook('__healthcheck__');
    } catch (err: unknown) {
      if (err instanceof NarratorrError && err.upstreamStatus === 404) return;
      throw err;
    }
  }

  // --- internals -------------------------------------------------------------

  private buildUrl(path: string, query?: Record<string, unknown>): string {
    const url = new URL(this.baseUrl + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  private async request<S extends z.ZodTypeAny>(
    method: string,
    path: string,
    schema: S,
    opts: { body?: unknown; headers?: Record<string, string>; query?: Record<string, unknown> } = {},
  ): Promise<z.infer<S>> {
    const url = this.buildUrl(path, opts.query);
    const label = `Narratorr ${method} ${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    // Keep the abort armed across BOTH the header read (`fetch`) and the body read
    // (`res.text()`): the timeout must bound a narratorr that flushes headers then stalls
    // the body, not just a slow-to-respond one. Clearing the timer in a `finally` that wraps
    // both — and translating an abort raised by either — is why the body read sits inside
    // this try. Everything after (JSON parse, error/contract handling) runs with the timer
    // already cleared, so no path leaks it.
    let res: Response;
    let text: string;
    try {
      res = await fetch(url, {
        method,
        signal: controller.signal,
        // A redirect must surface as OUR error rather than replaying the api key at the target:
        // the WHATWG cross-origin stripping rule covers `Authorization`, not our custom
        // `X-Api-Key`, so a followed 30x would hand the key to a host the upstream chose.
        // `redirect: 'error'` rejects the fetch, which the catch below classifies as NETWORK.
        redirect: 'error',
        headers: {
          'X-Api-Key': this.apiKey,
          ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...opts.headers,
        },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      });
      text = await res.text();
    } catch (err: unknown) {
      // Our OWN manual `controller.abort()` above is the mechanism, and it surfaces as an
      // `AbortError` — this predicate is the only part of the classification that is specific to
      // THIS client. What the boolean MEANS (code + message word) belongs to the shared
      // `classifyTransportFailure`, which `NarratorrStreamClient` calls too, so the taxonomy
      // cannot drift between them (#173).
      throw classifyTransportFailure(label, err instanceof Error && err.name === 'AbortError');
    } finally {
      clearTimeout(timer);
    }

    // The non-2xx branch owns the WHOLE text→error decision, ahead of any parse. Keeping the
    // parse below it is what scopes the empty-body → NON_JSON rule to failures structurally: a
    // 2xx with no body still falls through to the contract check and stays CONTRACT_MISMATCH.
    if (!res.ok) throw classifyErrorBody(label, res.status, text);

    // 2xx only from here.
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      throw new NarratorrError(res.status, 'NON_JSON', `${label} returned non-JSON`);
    }

    const result = schema.safeParse(json);
    if (!result.success) {
      throw new NarratorrError(res.status, 'CONTRACT_MISMATCH', `${label} response did not match the v1 contract`);
    }
    return result.data;
  }
}

export type INarratorrClient = Pick<
  NarratorrClient,
  'searchMetadata' | 'addBook' | 'getBook' | 'getSystem' | 'getCapabilities'
>;

// Per-consumer slices of the full client surface. Each service depends only on the calls it
// actually makes, so widening `INarratorrClient` (as `getCapabilities` did in issue #144) doesn't
// structurally force a capability method onto search/handoff/poller fakes that never call one.
// The swappable `NarratorrClientHolder` satisfies all of them, so production wiring is unchanged.
/** `SearchService` — metadata search only. */
export type IMetadataSearchClient = Pick<INarratorrClient, 'searchMetadata'>;
/** `RequestService` — the approved-request handoff only. */
export type IBookHandoffClient = Pick<INarratorrClient, 'addBook'>;
/** `StatusPoller` — lifecycle polling only. */
export type IBookStatusClient = Pick<INarratorrClient, 'getBook'>;
/** `FeatureService` — the capability probe only. */
export type ICapabilityClient = Pick<INarratorrClient, 'getCapabilities'>;
