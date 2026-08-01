// Pure favicon/title decisions for the instance badge (issue #135). These are decisions, not
// rendering, so they stay pure functions with co-located `.test.ts` coverage in the node project
// rather than being asserted through a jsdom render; the DOM wiring (`useInstanceBadge()` in
// hooks.ts) is a thin, untested-by-convention shim.
//
// The badge distinguishes a dev instance from prod when many squeezed tabs show only a favicon:
// color encodes ENVIRONMENT across the narratorr family (violet = dev), while the glyph/title keep
// distinguishing the app.

/** The dev accent — violet, per the pinned family-wide environment palette. */
export const BADGE_ACCENT = '#8b5cf6';

/** The served baseline glyph's accent (src/client/public/favicon.svg `stroke`), swapped for the
 *  badge accent when recoloring. */
const BASELINE_ACCENT = '#d97706';

/**
 * The app glyph, mirrored from `src/client/public/favicon.svg` (the served baseline). Inlined here
 * so the recolor is a pure, synchronous transform (no fetch, no new static asset) — the badge just
 * swaps the accent and encodes the result as a data URI. If the served favicon ever changes, update
 * this copy to match. The `stroke` here is {@link BASELINE_ACCENT}; every glyph `<path>` is verbatim.
 */
const GLYPH_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#d97706" ' +
  'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M3 18v-6a9 9 0 0 1 18 0v6" />' +
  '<path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" />' +
  '</svg>';

/**
 * Idempotent `[<badge>] ` title prefix. Re-applying with the same badge is a no-op, so a repeated
 * effect can never produce `[dev] [dev] Requests`.
 */
export function prefixTitle(title: string, badge: string): string {
  const prefix = `[${badge}] `;
  return title.startsWith(prefix) ? title : `${prefix}${title}`;
}

/**
 * The app glyph recolored to `accent` (default {@link BADGE_ACCENT}) as an `svg+xml` data URI —
 * the same glyph paths, no new static asset. `encodeURIComponent` percent-encodes the `#` of the
 * color (so the URI carries `%238b5cf6`, not a raw `#8b5cf6`), which is why callers/tests should
 * decode before asserting the color rather than substring-matching the raw fragment.
 */
export function badgedFaviconDataUri(accent: string = BADGE_ACCENT): string {
  return `data:image/svg+xml,${encodeURIComponent(GLYPH_SVG.replace(BASELINE_ACCENT, accent))}`;
}

/** What the tab's title + favicon href SHOULD be, given the configured badge. */
export interface BadgeDecision {
  title: string;
  faviconHref: string;
}

/**
 * Pure decision: given the configured badge (or `undefined`/blank when unset) and the current tab
 * state, return the title + favicon href to apply. Unset = IDENTITY (returns the inputs unchanged),
 * so the caller can compare-and-skip and never touch the DOM on the prod/unset path — no flash
 * (AC#1). A non-empty badge is trimmed, the title gets the idempotent prefix, and the favicon
 * becomes the violet-recolored data URI.
 */
export function decideBadge(badge: string | undefined, current: BadgeDecision): BadgeDecision {
  const b = badge?.trim();
  if (b === undefined || b === '') return { ...current };
  return { title: prefixTitle(current.title, b), faviconHref: badgedFaviconDataUri() };
}
