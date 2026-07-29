import { isNarratorrBookId } from '@shared/schemas/book-id';
import { humanizeBytes } from '../format-bytes';

// Every DECISION the companion-ebook sheet makes (issue #147), extracted out of the component so
// it is unit-tested directly rather than through the DOM. `EbookSheet.tsx` is left with the DOM
// orchestration these compose into.

/** The media type the proxy serves and the one we stamp on an assembled blob. */
export const EPUB_MEDIA_TYPE = 'application/epub+zip';

/**
 * The most we will ever buffer in memory for a download. `sizeBytes` is an UNBOUNDED `z.number()`
 * in the contract and a 25 MiB EPUB is an ordinary case, so this is a real ceiling, not a
 * formality — past it the download switches to a browser-owned navigation.
 */
export const MAX_BUFFERED_EPUB_BYTES = 64 * 1024 * 1024;

/** The server's own last-resort stem, used when the response carries no usable filename. */
export const FALLBACK_EPUB_FILENAME = 'companion.epub';

/** Shown for anything the proxy's stable codes don't cover — and for every non-code failure. */
export const GENERIC_DOWNLOAD_ERROR = 'Could not download the eBook.';

/**
 * Humanize `V1CompanionEbook.sizeBytes` for the sheet's size chip, or `null` for "render no size
 * chip at all". TOTAL over `number`, and the STEP ORDER is load-bearing:
 *
 * VALIDATE THE ORIGINAL INPUT FIRST, then round. Validating after rounding would be a defect —
 * `Math.round(-0.4)` is `-0` and `-0 < 0` is `false`, so a round-first implementation renders
 * `0 B` for a negative fraction the contract explicitly admits.
 *
 * `0` is a LEGITIMATE value narratorr deliberately round-trips: it renders "0 B", never "unknown"
 * and never a falsy-coerced blank. Positive fractions are legal too (the contract pins `0.5`), so
 * rounding resolves them — `0.5` → "1 B", `0.4` → "0 B". A negative or non-finite value yields
 * `null`, which is what keeps `NaN`/garbage out of the chip.
 */
export function formatEbookSize(sizeBytes: number): string | null {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) return null;
  return humanizeBytes(Math.round(sizeBytes));
}

/**
 * Build the same-origin proxy URL for a companion download, or `null` when the book id is one the
 * download route would never admit.
 *
 * TOTAL over every pair of JavaScript strings, and it NEVER calls `encodeURIComponent` — which
 * throws `URIError` on an unpaired surrogate, exactly the hazard the server's filename helper
 * documents. Two total mechanisms replace it:
 *   • the PATH SEGMENT is a validation GATE, not an encoder: `isNarratorrBookId()` is the download
 *     route's own grammar, so every character it admits is already URL-safe and a gated id can be
 *     interpolated raw. A `null` here means the affordance should never have been rendered.
 *   • the QUERY STRING is `URLSearchParams` (the prior art in `api.ts`'s `listUrl`), whose
 *     form-urlencoded serializer is total — it replaces an unpaired surrogate with U+FFFD rather
 *     than throwing — and guarantees `title` appears at most once.
 *
 * An empty or whitespace-only title is omitted entirely; the server's `epubFilename` then falls
 * back to the book id.
 */
export function buildEbookDownloadUrl({ bookId, title }: { bookId: string; title: string }): string | null {
  if (!isNarratorrBookId(bookId)) return null;
  const base = `/api/ebooks/${bookId}/download`;
  if (title.trim() === '') return base;
  const params = new URLSearchParams();
  params.set('title', title);
  return `${base}?${params.toString()}`;
}

/**
 * Whether a known byte count is already past the buffer bound. True ONLY for a finite value
 * strictly greater than {@link MAX_BUFFERED_EPUB_BYTES}: an unknown (`null`), unparseable, absent
 * or non-finite length is not evidence of anything, and the byte-counting accumulator enforces
 * the real bound regardless.
 */
export function exceedsBufferBound(bytes: number | null): boolean {
  return bytes !== null && Number.isFinite(bytes) && bytes > MAX_BUFFERED_EPUB_BYTES;
}

/** `content-length` as a number, or `null` when it is absent or not a finite number. */
export function parseContentLength(header: string | null): number | null {
  if (header === null || header.trim() === '') return null;
  const value = Number(header);
  return Number.isFinite(value) ? value : null;
}

/** What {@link readBoundedBlob} answers: the assembled body, or "this one is over the bound". */
export type BoundedBody = { kind: 'blob'; blob: Blob } | { kind: 'over-bound' };

/**
 * Read a response body into a `Blob`, BOUNDED BY CONSTRUCTION rather than by trusting a header.
 *
 * The guarantee is the running byte count: the moment the total would exceed `limit` the reader is
 * cancelled, every chunk is discarded and the over-bound sentinel is returned. `limit` is a
 * parameter (the constant is applied at the call site) so tests can drive the boundary with tiny
 * chunks instead of allocating 64 MiB.
 *
 * ABORT OWNERSHIP IS EXPLICIT: this helper only ever sees a `Response` and a number. The
 * `AbortController` belongs to the orchestration layer that created it for `fetch`, so cancelling
 * the READER is this function's job and aborting the CONTROLLER is the caller's.
 *
 * A `null` body is an immediate failure (the caller's post-OK failure rule owns it), and a reader
 * that rejects mid-stream rejects through — a 200 is not yet a success when the proxy can error
 * the stream mid-body.
 */
export async function readBoundedBlob(response: Response, limit: number): Promise<BoundedBody> {
  const body = response.body;
  if (!body) throw new Error('response body is empty');
  const reader = body.getReader();
  const chunks: BlobPart[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return { kind: 'over-bound' };
    }
    chunks.push(value);
  }
  return { kind: 'blob', blob: new Blob(chunks, { type: EPUB_MEDIA_TYPE }) };
}

/**
 * The filename the proxy synthesized, read from its `Content-Disposition` (same-origin, so the
 * header is readable). A blob URL carries no disposition, so without this the browser would name
 * the saved file after the opaque object URL.
 *
 * Prefers the RFC 5987 `filename*=UTF-8''…` form the server adds for any non-ASCII name; a
 * percent-decode failure falls THROUGH to the quoted ASCII `filename="…"` rather than throwing.
 * The result is reduced to its basename before it can reach `anchor.download`.
 */
export function filenameFromContentDisposition(header: string | null): string | null {
  if (!header) return null;
  const extended = /filename\*\s*=\s*([^;]+)/i.exec(header)?.[1]?.trim();
  if (extended) {
    // charset'language'percent-encoded-value — we only need the last part.
    const encoded = extended.split("'").slice(2).join("'");
    try {
      const decoded = basename(decodeURIComponent(encoded));
      if (decoded) return decoded;
    } catch {
      // An invalid percent sequence: fall through to the quoted ASCII form.
    }
  }
  const quoted = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(header)?.[1];
  if (quoted !== undefined) {
    const unescaped = basename(quoted.replace(/\\(.)/g, '$1'));
    if (unescaped) return unescaped;
  }
  const bare = /filename\s*=\s*([^;"]+)/i.exec(header)?.[1]?.trim();
  return bare ? basename(bare) || null : null;
}

/** Everything up to and including the last `/` or `\` is dropped. */
function basename(value: string): string {
  return value.slice(Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\')) + 1);
}

/**
 * Copy for the proxy's stable ACTION-DOMAIN error codes — the ones the route can return once the
 * active-user guard has passed. Anything else (an unknown code, a non-JSON body, a rejected
 * `fetch`) gets the generic fallback.
 *
 * The route's GUARD codes (`UNAUTHORIZED` / `ACCOUNT_PENDING` / `ACCOUNT_REJECTED`) are
 * deliberately NOT given bespoke copy: a session that expires between opening the sheet and
 * clicking Download gets the generic toast, and the app's existing `/api/me` gate owns the
 * sign-in experience. The sheet must not grow its own auth handling.
 */
const DOWNLOAD_ERROR_MESSAGES: Record<string, string> = {
  EBOOK_UNAVAILABLE: 'This book doesn’t have a companion eBook any more.',
  EBOOK_BUSY: 'The eBook is being prepared — try again in a few seconds.',
  EBOOKS_DISABLED: 'eBook downloads are turned off on this instance.',
  NOT_CONFIGURED: 'Narratorr isn’t connected. An admin can set it up in Settings.',
  NARRATORR_UNAVAILABLE: 'Narratorr is unreachable right now.',
  RATE_LIMITED: 'Too many downloads — wait a moment and try again.',
};

export function downloadErrorMessage(code: string): string {
  return DOWNLOAD_ERROR_MESSAGES[code] ?? GENERIC_DOWNLOAD_ERROR;
}

/**
 * The error code from a non-OK proxy response, or `''` when the body is missing, malformed or
 * non-JSON — all of which map to the generic message. Never throws.
 */
export async function downloadErrorCode(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
    return typeof code === 'string' ? code : '';
  } catch {
    return '';
  }
}

/** Hand an assembled body to the browser. Injectable so jsdom can stub it. */
export type SaveBlob = (blob: Blob, filename: string) => void;
/** Hand a URL to the browser to stream straight to disk (the over-bound path). */
export type NavigateToDownload = (url: string) => void;

/**
 * The DEFAULT save seam: object URL → a programmatic anchor with `download` → click → revoke.
 * The revoke lives in a `finally`, so the object URL is released even when the anchor step
 * throws — otherwise a failed save would leak the whole buffered EPUB for the tab's lifetime.
 */
export const saveBlobToDisk: SaveBlob = (blob, filename) => {
  const url = URL.createObjectURL(blob);
  try {
    clickDownloadAnchor(url, filename);
  } finally {
    URL.revokeObjectURL(url);
  }
};

/**
 * The DEFAULT navigate seam. Used only when the companion is over the buffer bound: the browser
 * owns the transfer and honors the proxy's own `Content-Disposition`. The accepted trade, stated
 * plainly: on this path an error response is SAVED as a small JSON file instead of raising a
 * toast, because a navigation exposes no status to JS.
 */
export const navigateToDownload: NavigateToDownload = (url) => {
  // An EMPTY `download`, deliberately: it keeps the SPA alive (the browser saves rather than
  // navigates away) while still letting the proxy's own `Content-Disposition` name the file.
  clickDownloadAnchor(url, '');
};

function clickDownloadAnchor(url: string, filename: string): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
}
