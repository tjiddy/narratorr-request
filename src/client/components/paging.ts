import { DEFAULT_LIMIT, MAX_LIMIT } from '@shared/schemas/v1/common';

// Pure paging decision logic for the request list views (My Requests, Admin Queue,
// per-user history). The lists use a bounded growing-limit fetch: each view holds a
// `limit` (starting at DEFAULT_LIMIT) and "load more" grows it by one page, capped at
// MAX_LIMIT. Extracted here so the has-more / next-limit decisions are unit-tested
// without a DOM render (this repo has no jsdom modality by design).

/**
 * Whether the server reports more rows than we've loaded. Drives the "Showing X of N"
 * count chrome — shown ONLY when rows are hidden, so a fully-loaded list (the common
 * case, `total <= loaded`) renders exactly as before with no extra chrome.
 */
export function hasMore(loaded: number, total: number): boolean {
  return loaded < total;
}

/**
 * The next page-size to request when the user loads more: one default page larger,
 * clamped to MAX_LIMIT so a growing-limit fetch never asks the server for more than it
 * allows (the server bounds `limit` at MAX_LIMIT too).
 */
export function nextLimit(limit: number): number {
  return Math.min(limit + DEFAULT_LIMIT, MAX_LIMIT);
}

/**
 * Whether the "Load more" control should render: more rows exist AND the growing-limit
 * hasn't reached the server cap. Past MAX_LIMIT the count still shows there's more, but
 * growing-limit can't fetch it (paging past 500 is intentionally out of scope).
 */
export function canLoadMore(loaded: number, total: number, limit: number): boolean {
  return hasMore(loaded, total) && limit < MAX_LIMIT;
}
