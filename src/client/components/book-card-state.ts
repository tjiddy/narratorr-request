import type { V1AudibleResult } from '@shared/schemas/v1/metadata';
import type { V1CompanionEbook } from '@shared/schemas/v1/companion-ebook';
import type { RequestStatus } from '@shared/schemas/request';
import { isNarratorrBookId } from '@shared/schemas/book-id';
import type { BadgeVariant } from './Badge';

/**
 * What a BookCard's action area should show, resolved from two independent signals:
 *   - `requestedStatus` — THIS viewer's own request on this ASIN (if they have one).
 *   - `library` — narratorr's library status for this ASIN (issue #1537), present for
 *     any book narratorr already owns, regardless of who added it.
 *
 * Precedence (most-actionable wins):
 *   1. Library `imported` → "In library". The book is available now; requesting is
 *      pointless. This overrides even the viewer's own request row — an imported book
 *      IS that request's happy outcome, so "In library" beats a stale "Requested".
 *   2. The viewer's own request → their personal request badge (Requested / Denied / …).
 *      It's their explicit, actionable state and outranks a library row owned by others.
 *   3. Library in-flight (wanted / searching / downloading / importing) → "On the way":
 *      narratorr is already acquiring it, so don't offer a duplicate request.
 *   4. Otherwise (library failed/missing/absent AND no request of their own) → Request.
 *
 * narratorr emits the raw BookStatus only; the tri-state collapse lives here by design.
 */

/**
 * The companion-ebook affordance (issue #147) — a property of the IMPORTED branch only, so the
 * four-way precedence above is untouched. Three explicit states, because a user hunting an ebook
 * should never have to infer availability from an absence:
 *   - `available` → the green "Get eBook" button, carrying everything the sheet needs;
 *   - `absent`    → the muted "No eBook" chip (in library, no companion);
 *   - `none`      → render nothing at all (the feature is off, or the book isn't imported).
 */
export type EbookAffordance =
  | { kind: 'none' }
  | { kind: 'absent' }
  | { kind: 'available'; bookId: string; companion: V1CompanionEbook };

export type BookCardState =
  | { kind: 'request' }
  | { kind: 'request-status'; status: RequestStatus }
  | { kind: 'library'; label: string; variant: BadgeVariant; pulse: boolean; ebook: EbookAffordance };

const NO_EBOOK: EbookAffordance = { kind: 'none' };

export function resolveBookCardState(
  library: V1AudibleResult['library'],
  requestedStatus: RequestStatus | undefined,
  ebooksEnabled = false,
): BookCardState {
  if (library?.status === 'imported') {
    return {
      kind: 'library',
      label: 'In library',
      variant: 'success',
      pulse: false,
      ebook: resolveEbookAffordance(library, ebooksEnabled),
    };
  }
  if (requestedStatus) return { kind: 'request-status', status: requestedStatus };
  if (library && library.status !== 'failed' && library.status !== 'missing') {
    // wanted | searching | downloading | importing — narratorr is acquiring it. A companion
    // can't be offered yet even if narratorr already annotated one.
    return { kind: 'library', label: 'On the way', variant: 'info', pulse: true, ebook: NO_EBOOK };
  }
  return { kind: 'request' };
}

/**
 * `null` and `undefined` companions are BOTH "no companion" and resolve identically — the
 * annotation is `.nullable().optional().catch(undefined)`, so an absent key (a pre-#1961
 * narratorr) and drift the inner catch swallowed are deliberately indistinguishable.
 *
 * The `bookId` gate is the no-dead-button rule: a companion whose id fails the download route's
 * own grammar could never reach the handler, so it resolves to `absent` rather than rendering a
 * button that can only ever 404.
 */
function resolveEbookAffordance(
  library: NonNullable<V1AudibleResult['library']>,
  ebooksEnabled: boolean,
): EbookAffordance {
  if (!ebooksEnabled) return NO_EBOOK;
  const companion = library.companionEbook;
  if (!companion || !isNarratorrBookId(library.bookId)) return { kind: 'absent' };
  return { kind: 'available', bookId: library.bookId, companion };
}
