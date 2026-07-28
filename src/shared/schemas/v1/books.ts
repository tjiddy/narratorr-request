import { z } from 'zod';
import { bookStatusSchema } from '../book.js';
import { v1CompanionEbookSchema } from './companion-ebook.js';
import { isoDateString, prefixedId } from './common.js';
import { authorRefSchema, narratorRefSchema, seriesRefSchema } from './refs.js';

// =============================================================================
// VENDORED CONTRACT — Narratorr `/api/v1`, endpoints 2 & 3: the book resource.
// (See `./metadata.ts` for the integration overview + endpoint 1.)
//
// The request app owns requests/approval/quota/notifications; narratorr owns the
// library. An approved request adds the book by ASIN, then polls it until `imported`
// (= available). There is NO idempotency key: an add for an ASIN that already exists
// returns 409 with `existingId`, which the client resolves into the existing book — so
// an add is effectively idempotent by ASIN. Single resources are returned BARE (no
// `{ data }` wrapper).
// =============================================================================

// --- 2. Add the book — POST /api/v1/books { asin } → V1Book (bare, 201) -------
// The "I want this book" command: narratorr hydrates the ASIN and creates the book. The
// body is `{ asin }` only — acquisition is NOT the caller's to control; when/how the book
// is searched follows narratorr's OWN operator settings. So a freshly added book may sit
// at `wanted` until the operator's next scheduled search sweep — normal, not a failure.
// Response codes carry the semantics (no idempotency key):
//   - 201 → newly created; returns the bare V1Book.
//   - 400 → malformed body (e.g. missing/empty `asin`); no book created (terminal).
//   - 409 → a book with this ASIN already EXISTS (lost-response retry, or a second user
//           wanting it). Body { error, existingId }; the client resolves `existingId`, so
//           the add is idempotent by ASIN — no duplicate created, nothing re-grabbed. Runs
//           BEFORE the 422 gate: an already-owned ASIN is a 409, never a 422.
//   - 422 → the add was rejected at the gate (narratorr #1545); no book created (terminal).
//           The `error.code` is one of ADD_BOOK_ERROR_CODES — `edition_rejected` (excluded by
//           the owner's reject-words), `asin_not_resolved` (provider can't resolve the ASIN),
//           or `invalid_record` (incomplete provider record). Branch on `code`, never message.
//   - 429 → metadata provider rate-limited; retry after a backoff (transient).
//   - 502 → provider_unavailable; the upstream metadata provider is down (transient).
export const v1AddBookBodySchema = z.object({ asin: z.string().min(1) }).strict();

/**
 * Authoritative `error.code` strings a `422` from `POST /api/v1/books` can carry
 * (narratorr #1545, as-shipped). Single source of truth so the service and the test
 * fixture branch on named codes, not inline string literals. Consumer-lenient by
 * convention: an unrecognized code is handled as a generic terminal failure, not a crash.
 */
export const ADD_BOOK_ERROR_CODES = {
  /** Edition excluded by the library owner's reject-words filter. */
  editionRejected: 'edition_rejected',
  /** The metadata provider couldn't resolve the ASIN to a record. */
  asinNotResolved: 'asin_not_resolved',
  /** The provider returned an incomplete/unusable record. */
  invalidRecord: 'invalid_record',
} as const;
export type AddBookErrorCode = (typeof ADD_BOOK_ERROR_CODES)[keyof typeof ADD_BOOK_ERROR_CODES];

// --- 3. Poll — GET /api/v1/books/:publicId → V1Book (bare) --------------------
// The single resource the request app polls (also the shape POST /books returns). `status`
// is narratorr's authoritative library lifecycle, copied straight from the book record;
// available = `imported`; 404 only if the publicId doesn't resolve.
//
// KNOWN GAP: a search that finds nothing leaves the book at `wanted` indefinitely (it does
// NOT flip to `failed`). The request app doesn't second-guess this with a timer — such a
// request simply stays `acquiring` (in progress) until narratorr resolves it; an admin can
// deny it manually. Timing is narratorr's, not ours. We consume only `id` + `status`;
// everything else is modeled leniently.
export const v1BookSchema = z.object({
  id: prefixedId('bk'),
  title: z.string(),
  authors: z.array(authorRefSchema),
  narrators: z.array(narratorRefSchema),
  series: seriesRefSchema.nullable().optional(),
  coverUrl: z.string().nullable().optional(),
  asin: z.string().nullable().optional(),
  status: bookStatusSchema,
  // Companion ebook (narratorr #1961). Contract substrate, not the live surface: the
  // consumer surface is the nested `library.companionEbook` annotation in ./metadata.ts.
  // `.optional()` for the same reason as there (a pre-#1961 narratorr omits the key), and
  // `.catch(undefined)` is LOAD-BEARING here for a sharper reason: this schema backs both
  // addBook() and the poller's getBook() (narratorr-client.ts), which is what drives
  // `acquiring → available`. A drifted companion field must never turn a poll into a
  // 502 CONTRACT_MISMATCH and strand a request at `acquiring` forever.
  companionEbook: v1CompanionEbookSchema.nullable().optional().catch(undefined),
  createdAt: isoDateString.optional(),
});
export type V1Book = z.infer<typeof v1BookSchema>;
