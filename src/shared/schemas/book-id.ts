/**
 * narratorr's opaque public book id — OUR admission grammar for it, shared by the client (which
 * decides whether to render a download affordance) and the download route (which decides whether
 * to serve one). Our own domain, deliberately NOT the vendored `v1/` mirror: the LENGTH cap is a
 * routing constraint of ours, not something narratorr's contract states.
 *
 * The `bk_` prefix is contract (`prefixedId('bk')` on the book DTO); past it the token is a
 * base64url `randomBytes(16)`, so `-` and `_` are routine. Bounded at 64 characters total —
 * deliberately BELOW Fastify's default `maxParamLength` of 100, so every id this grammar could
 * accept reaches the handler rather than being refused by the router first.
 *
 * `prefixedId('bk')` alone is NOT a sufficient gate: it is unbounded, so a 98-token id would pass
 * it, render a live affordance, and then produce a path segment the router refuses with a generic
 * `NOT_FOUND` before the handler ever runs — a dead button by construction. One regex, two
 * admission decisions, so client and server can never drift apart.
 */
const BOOK_ID_RE = /^bk_[A-Za-z0-9_-]{1,61}$/u;

/** Whether `value` is a book id BOTH the download affordance and the download route admit. */
export const isNarratorrBookId = (value: string): boolean => BOOK_ID_RE.test(value);
