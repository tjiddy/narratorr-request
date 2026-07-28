import type { FeaturesDto } from '@shared/schemas/features';
import { isApprovedUser, type MeDto } from '@shared/schemas/user';

// Pure feature-gating predicates for the SPA (issue #144). Kept out of the components so the
// decision logic is unit-tested directly rather than through the DOM.
//
// UI HIDING IS NOT AUTHORIZATION. These predicates only decide what to RENDER. Every server route
// that acts on the flags — the EPUB download proxy (#146) and the send-to-Kindle route (#148) —
// must re-check both the admin toggle and the narratorr capability server-side, because a client
// can call those routes whether or not it ever saw an affordance.

/**
 * What the gate reads: whatever `useFeatures()` currently knows. Deliberately shaped as the
 * query's own state rather than a bare payload, so the loading and error cases are decisions the
 * predicate makes — not ones each call site improvises.
 */
export interface FeaturesState {
  data: FeaturesDto | undefined;
  isError?: boolean | undefined;
}

/**
 * Whether to render eBook affordances. FAIL-SAFE: `false` unless the payload explicitly says
 * otherwise — a still-loading query, an errored one, and an unset payload all resolve to off, so a
 * flaky `/api/features` shows the feature as unavailable rather than flashing a dead affordance.
 */
export const ebooksVisible = (state: FeaturesState): boolean =>
  !state.isError && state.data?.ebooksEnabled === true;

/**
 * Whether to render Send-to-Kindle affordances. Strictly narrower than {@link ebooksVisible} — the
 * server already enforces `kindleDeliveryAvailable ⇒ ebooksEnabled`, but re-deriving through the
 * same gate keeps the client honest if that payload were ever served stale or half-parsed.
 */
export const kindleDeliveryVisible = (state: FeaturesState): boolean =>
  ebooksVisible(state) && state.data?.kindleDeliveryAvailable === true;

/**
 * Whether the features query should run at all. `/api/features` is `requireActiveUser`, so it
 * would 401 on the login screen and 403 on the pending/rejected screen — pointless requests that
 * would also surface as query errors.
 *
 * The role/status decision is NOT restated here: it comes from the shared {@link isApprovedUser},
 * the same predicate the server guard enforces. This function owns only the client-side extra —
 * that an unauthenticated caller (no `me` payload yet) has nothing to gate on.
 */
export const featuresQueryEnabled = (me: MeDto | undefined): boolean =>
  me !== undefined && isApprovedUser(me);
