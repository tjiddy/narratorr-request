import { isNarratorrBookId } from '@shared/schemas/book-id';
import type { EbookSendOutcome } from '@shared/schemas/ebooks';
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

// --- Send to Kindle (issue #149) ---------------------------------------------
// The sheet's second leg. Everything below is a DECISION — hierarchy, masking, and the two copy
// tables — extracted for the same reason the download helpers above are: so it is asserted
// directly rather than through the DOM.

/**
 * Which of the sheet's two actions is the amber primary, and why.
 *
 * The sheet's rule is "exactly ONE amber button, and it is the one this user can actually act on",
 * so the hierarchy has to be a single total decision rather than a pile of ternaries in the JSX.
 * The three states map 1:1 onto what the user must do next:
 *   • `send-primary`      — an address is saved and delivery works: Send on top, Download beneath.
 *   • `address-missing`   — delivery works but the user has no device address: Download on top,
 *                           Send disabled beneath a hint that opens the account modal.
 *   • `delivery-unavailable` — the instance cannot send at all: Download on top, Send disabled
 *                           with honest copy. Adding an address would not help, so no hint.
 *
 * `kindleEmail` arrives from `MeDto.kindleEmail`, a plain nullable string on the DTO — NOT the
 * refined `kindleEmailSchema` — so whitespace is a value this has to decide about rather than
 * assume away. A whitespace-only address is `address-missing`, never `send-primary`: the server
 * would have nowhere to send, and a truthiness check would render a masked caption for it.
 */
export type EbookSheetHierarchy =
  | { kind: 'send-primary'; kindleEmail: string }
  | { kind: 'address-missing' }
  | { kind: 'delivery-unavailable' };

/**
 * TOTAL over every `(kindleDeliveryVisible × kindleEmail)` pair. `kindleDeliveryVisible` must come
 * from the fail-safe `kindleDeliveryVisible()` gate in `../features`, never off `.data` — the gate
 * already folds "still loading" and "the query errored" into `false`, which is what makes
 * `delivery-unavailable` the honest answer in all three of those cases with one branch.
 */
export function decideEbookSheetHierarchy({
  kindleEmail,
  kindleDeliveryVisible,
}: {
  kindleEmail: string | null;
  kindleDeliveryVisible: boolean;
}): EbookSheetHierarchy {
  if (!kindleDeliveryVisible) return { kind: 'delivery-unavailable' };
  const trimmed = (kindleEmail ?? '').trim();
  return trimmed === '' ? { kind: 'address-missing' } : { kind: 'send-primary', kindleEmail: trimmed };
}

/** Everything before the first `@`, or the whole string when there is none. */
function localPartOf(value: string): string {
  const at = value.indexOf('@');
  return at < 0 ? value : value.slice(0, at);
}

/**
 * Mask a Kindle address for DISPLAY: `todd@kindle.com` → `t…d@kindle.com`.
 *
 * TOTAL over arbitrary strings and it never throws. That matters because `MeDto.kindleEmail` is a
 * plain nullable string on the DTO, not the refined write schema — a value stored before that
 * schema existed, or a hand-crafted PATCH, can reach this helper looking like nothing in
 * particular, and a caption is not the place to discover it.
 *
 * The disclosure bound is deliberate: for a well-formed address the first and last code point of
 * the local part survive (the mockup's shape — enough for the owner to recognize their own
 * device), for a 1- or 2-character local part only the FIRST does (never echo a whole local part),
 * and for anything malformed — no `@`, an empty local part, an empty domain, a second `@` — only
 * the first code point of the pre-`@` portion does. CODE POINTS, not UTF-16 units: indexing a
 * string would split an emoji into lone surrogates and render mojibake.
 */
export function maskKindleAddress(value: string): string {
  const trimmed = value.trim();
  const at = trimmed.indexOf('@');
  const local = [...localPartOf(trimmed)];
  const head = local[0] ?? '';
  // No `@` at all: there is no domain to keep, so the mask is just the disclosed head.
  if (at < 0) return `${head}…`;
  const domain = trimmed.slice(at + 1);
  // Malformed — an empty local part, an empty domain, or a second `@`. Disclose the head and
  // nothing else; the remainder is echoed verbatim because it is not a local part at all.
  if (local.length === 0 || domain === '' || domain.includes('@')) return `${head}…@${domain}`;
  const tail = local.length > 2 ? local[local.length - 1] : '';
  return `${head}…${tail}@${domain}`;
}

/**
 * The State-A caption: who it goes to (masked) and who it arrives from.
 *
 * `kindleSenderEmail` is `null`-able on the features payload. The server's invariant says a visible
 * Kindle feature always carries a confirmed sender, but the client stays total: an absent sender
 * DROPS the whole "arrives from" clause rather than rendering the string `null`.
 */
export function kindleSendCaption(kindleEmail: string, senderEmail: string | null): string {
  const masked = maskKindleAddress(kindleEmail);
  return senderEmail ? `Sends to ${masked} · arrives from ${senderEmail}` : `Sends to ${masked}`;
}

/** State B's hint — the lead-in; {@link KINDLE_ADDRESS_HINT_ACTION} is the control that follows it. */
export const KINDLE_ADDRESS_HINT = 'Send to Kindle needs your device address —';
/** The activatable half of State B's hint. Opens the account modal; never a navigating `<a href>`. */
export const KINDLE_ADDRESS_HINT_ACTION = 'add it in your account';
/** State C's copy. Honest about the instance, not about the user — adding an address wouldn't help. */
export const KINDLE_DELIVERY_UNAVAILABLE = 'Send to Kindle isn’t available on this instance right now.';

/**
 * Copy for every member of the service's outcome union. EVERY admitted attempt answers
 * `200 { outcome }` — the failures included — so this table, not the status code, is what the user
 * hears about a send.
 *
 * Keyed by the SHARED `EbookSendOutcome`, so a member added server-side is a typecheck failure here
 * rather than a silently missing toast.
 *
 * `no_kindle_address` and `no_sender` should be unreachable behind the hierarchy's State B/C gates,
 * but they are genuinely reachable in practice: the features payload has a 60s `staleTime`, and an
 * address cleared in another tab is invisible to this one until `qk.me` refetches.
 */
export const EBOOK_SEND_OUTCOME_MESSAGES: Record<EbookSendOutcome, string> = {
  sent: 'Sent to Amazon — conversion and delivery happen on Amazon’s side.',
  // Deliberately NOT "try again": a duplicate send is the expensive mistake here, and the Kindle
  // library is the only place that can actually answer whether the first one landed.
  indeterminate: 'We couldn’t confirm the handoff. Don’t resend immediately — check your Kindle library first.',
  rate_limited: 'You’ve sent a few too quickly. Wait a minute and try again.',
  quota_exhausted: 'Your send allowance is used up for now — try again later.',
  too_large: 'This eBook is too large to email. Download it instead.',
  unavailable: 'This book doesn’t have a companion eBook any more.',
  no_kindle_address: 'Add a Kindle device address in your account first.',
  no_sender: 'Send to Kindle isn’t configured on this instance.',
  failed: 'The send failed. You can download the eBook instead.',
};

export function sendOutcomeMessage(outcome: EbookSendOutcome): string {
  return EBOOK_SEND_OUTCOME_MESSAGES[outcome];
}

/** Shown for every REJECTED send the code table below doesn't cover, including a network failure. */
export const GENERIC_SEND_ERROR = 'Could not send the eBook to Kindle.';

/**
 * Copy for a REJECTED request — a thrown `ApiError`, which is a different thing from an outcome.
 * Keyed on the envelope CODE.
 *
 * A `Record<string, string>` lookup, NOT an exhaustive switch over the four bespoke codes: this
 * route can also emit the central handler's `PAYLOAD_TOO_LARGE` (413) and
 * `UNSUPPORTED_MEDIA_TYPE` (415), and `parse<T>` mints `NON_JSON` for a malformed body — all of
 * which must reach the generic message rather than `undefined`.
 *
 * The GUARD codes (`UNAUTHORIZED` / `ACCOUNT_PENDING` / `ACCOUNT_REJECTED`) get no bespoke copy, the
 * same doctrine the download leg follows: the app's `/api/me` gate owns the sign-in experience and
 * the sheet must not grow its own auth handling.
 *
 * There is deliberately no 429 entry — the send route carries no Fastify limiter, and the
 * per-minute cap surfaces as `200 { outcome: 'rate_limited' }` through the outcome table above.
 */
const SEND_ERROR_MESSAGES: Record<string, string> = {
  EBOOKS_DISABLED: 'Send to Kindle is turned off on this instance.',
  EBOOK_UNAVAILABLE: 'This book doesn’t have a companion eBook any more.',
  BAD_REQUEST: 'That send request wasn’t accepted — reload the page and try again.',
  INTERNAL: 'Something went wrong on our side. Try again in a moment.',
};

export function sendErrorMessage(code: string): string {
  return SEND_ERROR_MESSAGES[code] ?? GENERIC_SEND_ERROR;
}
