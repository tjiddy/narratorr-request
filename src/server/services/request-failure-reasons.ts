import { ADD_BOOK_ERROR_CODES, type V1Book } from '../../shared/schemas/v1/books.js';
import { NarratorrError } from './narratorr-client.js';

// Friendly failure reasons + the handoff terminal/transient classifier. Split out of
// `request.service.ts` (its own concern; keeps that file under the line cap). Once a
// `failureReason` is surfaced to users/admins it must read as plain English, not a raw upstream
// code — so these map every terminal failure cause to a friendly string, branching on the upstream
// CODE (narratorr #1545), never the human message text.

/**
 * Whether a handoff error is terminal (retrying can't fix it → fail the request) vs.
 * transient (429 rate-limit / 5xx / network → leave `approved` for the poller to
 * retry). A non-Narratorr error (e.g. a DB fault) is terminal so it can't loop forever.
 */
export function isTerminalHandoffError(err: unknown): boolean {
  if (!(err instanceof NarratorrError)) return true;
  // 400 malformed, 409 with no usable existingId, 422 unresolvable ASIN.
  return err.upstreamStatus === 400 || err.upstreamStatus === 409 || err.upstreamStatus === 422;
}

/** Per-code friendly text for the add-handoff terminal errors. */
const HANDOFF_FAILURE_REASONS: Record<string, string> = {
  [ADD_BOOK_ERROR_CODES.editionRejected]: "This edition is excluded by the library's filters.",
  [ADD_BOOK_ERROR_CODES.asinNotResolved]: "Couldn't find this book in the catalog.",
  [ADD_BOOK_ERROR_CODES.invalidRecord]: 'Incomplete book data from the provider.',
};

/** "The book is gone upstream" reason — written by the poller's 404 path (status-poller). */
export const BOOK_VANISHED_REASON = 'This book is no longer available upstream.';

/**
 * Friendly reason for a TERMINAL handoff error. A recognized `NarratorrError` code maps
 * to its per-code message; an unknown terminal code falls back to the readable
 * `${code}: ${message}` shape; a non-`NarratorrError` throw is a generic 'handoff failed'.
 */
export function handoffFailureReason(err: unknown): string {
  if (err instanceof NarratorrError) {
    return HANDOFF_FAILURE_REASONS[err.upstreamCode] ?? `${err.upstreamCode}: ${err.message}`;
  }
  return 'handoff failed';
}

/**
 * Friendly reason for a book whose status maps to `failed` (`failed` / `missing`). Any
 * other status shouldn't reach here (only `failed`/`missing` collapse to a failed request),
 * but it degrades to a readable `book ${status}` string rather than throwing.
 */
export function bookStatusFailureReason(status: V1Book['status']): string {
  switch (status) {
    case 'failed':
      return 'Download failed upstream.';
    case 'missing':
      return 'No source found upstream.';
    default:
      return `book ${status}`;
  }
}
