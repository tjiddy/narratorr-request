import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppDeps } from '../services/deps.js';
import type { NarratorrEbookStream } from '../services/narratorr-stream-client.js';
import { NarratorrError } from '../services/narratorr-client.js';
import { resolveFeatures } from '../services/feature-state.js';
import { requireActiveUser } from '../plugins/auth.js';
import { ebookDownloadRateLimitOptions } from '../plugins/rate-limit.js';
import { epubFilename, contentDispositionAttachment } from '../util/epub-filename.js';
import { ApiError, badGateway } from '../util/errors.js';

/**
 * narratorr's opaque public book id. The `bk_` prefix is contract (`prefixedId('bk')` on the book
 * DTO); past it the token is a base64url `randomBytes(16)`, so `-` and `_` are routine. Bounded at
 * 64 characters total — deliberately BELOW Fastify's default `maxParamLength` of 100, so every id
 * this grammar could accept reaches the handler rather than being refused by the router first.
 */
const BOOK_ID_RE = /^bk_[A-Za-z0-9_-]{1,61}$/u;

/** The one media type we pass through; anything else is neutralized to a non-renderable type. */
const EPUB_MEDIA_TYPE = 'application/epub+zip';

/** Codes are the client contract; the messages are ours, so no upstream text can ride out. */
const ebooksDisabled = () =>
  new ApiError(403, 'EBOOKS_DISABLED', 'Companion ebook downloads are not available on this instance.');
const ebookUnavailable = () =>
  new ApiError(404, 'EBOOK_UNAVAILABLE', 'No companion ebook is available for this book.');
const ebookBusy = () =>
  new ApiError(503, 'EBOOK_BUSY', 'The companion ebook is being prepared. Please try again shortly.');
const narratorrUnavailable = () =>
  badGateway('NARRATORR_UNAVAILABLE', 'The companion ebook could not be fetched from narratorr.');

/**
 * `Content-Type` is NEVER forwarded verbatim (AC12): an upstream `text/html` must not be able to
 * become a same-origin HTML response. Compared on the media type only — case-insensitively, with
 * parameters ignored.
 */
export function proxyContentType(upstream: string | null): string {
  const media = (upstream ?? '').split(';')[0]?.trim().toLowerCase();
  return media === EPUB_MEDIA_TYPE ? EPUB_MEDIA_TYPE : 'application/octet-stream';
}

/**
 * Map an upstream failure to OUR stable envelope (AC21), keyed on `upstreamStatus` — NOT on the
 * upstream code string. A bodiless upstream error arrives as `NON_JSON` with the status intact, so
 * a mapping keyed on `companion_epub_disabled` would drop a bodiless 409 into the generic 502.
 *
 * AC39, the provenance rule: an error carrying an HTTP status maps through the status table; only
 * a STATUS-ZERO error can be a local control state. `NarratorrStreamClient.errorFor()` preserves a
 * parsed upstream envelope code verbatim, so a hostile narratorr can answer HTTP 500 with
 * `{"error":{"code":"NOT_CONFIGURED"}}` — that is a 502 here, and its message never reaches the
 * browser. Only the holder's locally-authored `NOT_CONFIGURED` (status 0) is re-thrown so the
 * central handler can surface our own "set it up in Settings" message.
 */
export function mapUpstreamFailure(err: unknown, reply: FastifyReply): ApiError {
  if (!(err instanceof NarratorrError)) return narratorrUnavailable();
  if (err.upstreamStatus === 0) {
    return err.upstreamCode === 'NOT_CONFIGURED' ? err : narratorrUnavailable();
  }
  switch (err.upstreamStatus) {
    case 409:
      return ebooksDisabled();
    case 404:
    case 400:
      // A 400 becomes our 404 on purpose: a distinct status would make this route an oracle for
      // "does narratorr know this id".
      return ebookUnavailable();
    case 503:
      // Set on the reply BEFORE throwing — the central error handler reuses the same reply.
      reply.header('retry-after', '5');
      return ebookBusy();
    default:
      return narratorrUnavailable();
  }
}

/**
 * Re-emit the already-peeked chunk, then pump the SAME upstream reader — exactly one upstream
 * `read()` per `pull()`, so nothing reads ahead of what the downstream socket has accepted.
 * Fastify's `sendWebStream` supplies the rest of the backpressure (`res.write() === false` →
 * wait for `drain`) and destroys the raw response if this stream errors after headers are sent,
 * which is what turns a mid-body upstream failure into a failed download rather than a clean
 * short body.
 */
function wrapPeekedStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  peeked: ReadableStreamReadResult<Uint8Array>,
): ReadableStream<Uint8Array> {
  let pending: ReadableStreamReadResult<Uint8Array> | null = peeked;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = pending ?? (await reader.read());
        pending = null;
        if (result.done) controller.close();
        else controller.enqueue(result.value);
      } catch (err) {
        controller.error(err);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/** The per-request liveness state AC26's two seams are evaluated against. */
interface Liveness {
  signal: AbortSignal;
  /** `request.raw.aborted || reply.raw.destroyed || controller.signal.aborted`. */
  gone(): boolean;
}

/**
 * Derive liveness from socket STATE, not from catching an event (AC26). `close` is one-shot and
 * fires long before this handler exists — `authPlugin`'s `onRequest` hook awaits `users.getById`
 * and the limiter awaits its store — and Fastify guards the handler only on `reply.sent`
 * (`hijacked || raw.writableEnded`), which is FALSE for a destroyed socket. So the controller is
 * seeded from current state on entry, which reconstructs a `close` that already fired; the
 * listener is a supplement, never the sole source of truth.
 */
function trackLiveness(request: FastifyRequest, reply: FastifyReply): Liveness {
  const controller = new AbortController();
  if (request.raw.aborted || reply.raw.destroyed) controller.abort();
  reply.raw.on('close', () => {
    if (!reply.raw.writableFinished) controller.abort();
  });
  return {
    signal: controller.signal,
    gone: () => request.raw.aborted || reply.raw.destroyed || controller.signal.aborted,
  };
}

/**
 * `GET /api/ebooks/:bookId/download` — the same-origin companion-EPUB proxy (issue #146).
 *
 * The browser must never see narratorr's URL, api key or filesystem paths, so this route is the
 * ONLY thing that talks to the companion endpoint. Three properties it exists to hold:
 *   • ONE upstream companion request per download, opened only after the guard, both feature
 *     flags and the id grammar have passed — and never at all if the caller already walked away.
 *   • PEEK-THEN-STREAM: read exactly one chunk before committing any success header, so a failed
 *     first read is an ordinary JSON error with no `Content-Disposition` clinging to it, and a
 *     failure after the commit destroys the socket instead of appending JSON to partial bytes.
 *   • Only two headers are ever DERIVED from upstream — the content-type decision and the parsed
 *     content-length. Everything else is synthesized here.
 */
export function registerEbookRoutes(app: FastifyInstance, deps: AppDeps): void {
  // No response schema at all (AC4): the payload is a byte stream, not a serializable DTO.
  // `exposeHeadRoute` is SINGULAR — the plural is the server-global option — so Fastify does not
  // auto-add a HEAD twin that would open an upstream stream only to discard it.
  // In AUTH_BYPASS every request is the dev admin, so a cap could only let a dev lock themselves
  // out; the limiter is opt-in (`global: false`), so omitting the config disables it outright.
  app.get<{ Params: { bookId: string }; Querystring: Record<string, unknown> }>(
    '/api/ebooks/:bookId/download',
    {
      exposeHeadRoute: false,
      config: deps.config.authMode === 'bypass' ? {} : { rateLimit: ebookDownloadRateLimitOptions },
    },
    async (request, reply) => {
      const live = trackLiveness(request, reply);
      try {
        // Lexically inside the handler: the route-guard manifest greps for this, and it must run
        // before the id grammar so a malformed id can never answer ahead of authorization.
        requireActiveUser(request);

        // Re-checked on EVERY download through the shared resolver, so enforcement can never
        // disagree with what `/api/features` told the same caller. Fail-closed by construction.
        if (!(await resolveFeatures(deps)).ebooksEnabled) throw ebooksDisabled();

        const { bookId } = request.params;
        if (!BOOK_ID_RE.test(bookId)) throw ebookUnavailable();

        // Fastify's querystring parser yields an ARRAY for a repeated key; only a string is
        // usable, and the filename helper decides that. The title only ever affects THIS
        // caller's Content-Disposition and is never echoed anywhere else.
        const filename = epubFilename({ title: request.query?.title, bookId });

        // AC26 rule 1: the one place a companion stream is opened, guarded immediately before it.
        // (`resolveFeatures` may still hit its own cached `/capabilities` probe — that is
        // FeatureService's traffic, shared with `/api/features`, not per-download traffic.)
        if (live.gone()) return reply.hijack();

        const { stream, reader, peeked } = await openAndPeek(deps, bookId, live.signal, reply);

        // The success seam. Everything above this line is header-phase: nothing has been written,
        // so a caller who left gets no response attempt at all.
        if (live.gone()) {
          void reader.cancel().catch(() => {});
          return reply.hijack();
        }
        reply.header('content-type', proxyContentType(stream.contentType));
        // Forwarded EXACTLY when the client parsed one, the legitimate `0` included; a null
        // length means chunked, not "guess".
        if (stream.contentLength !== null) reply.header('content-length', String(stream.contentLength));
        reply.header('content-disposition', contentDispositionAttachment(filename));
        reply.header('cache-control', 'private, no-store');
        reply.header('x-content-type-options', 'nosniff');
        return reply.send(wrapPeekedStream(reader, peeked));
      } catch (err) {
        // The failure seam. A caller who is already gone is an expected outcome, not an error:
        // returning here means no dead-socket write, no unhandled rejection and no error-level
        // log line. Otherwise this throws exactly as before, so the central error handler stays
        // the sole formatter of our envelope.
        if (live.gone()) return reply.hijack();
        throw err;
      }
    },
  );
}

/**
 * Open the upstream stream and read its FIRST chunk under one error mapping, so a raw
 * (non-`NarratorrError`) rejection from either half becomes 502 `NARRATORR_UNAVAILABLE` rather
 * than landing on the central handler's generic 500 `INTERNAL`.
 */
async function openAndPeek(
  deps: AppDeps,
  bookId: string,
  signal: AbortSignal,
  reply: FastifyReply,
): Promise<{
  stream: NarratorrEbookStream;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  peeked: ReadableStreamReadResult<Uint8Array>;
}> {
  // Reached through the HOLDER, never a captured inner client, so a live reconnect in Settings is
  // observed and an unconfigured instance surfaces NOT_CONFIGURED.
  let stream: NarratorrEbookStream;
  try {
    stream = await deps.narratorr.openCompanionEpub(bookId, { signal });
  } catch (err) {
    throw mapUpstreamFailure(err, reply);
  }
  const reader = stream.body.getReader();
  try {
    return { stream, reader, peeked: await reader.read() };
  } catch (err) {
    void reader.cancel().catch(() => {});
    throw mapUpstreamFailure(err, reply);
  }
}
