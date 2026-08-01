import type { FastifyRequest } from 'fastify';
import { isApprovedUser } from '../../shared/schemas/user.js';

/**
 * Shared @fastify/rate-limit registration options for the auth endpoints. Factored out
 * so the server and the route tests configure the limiter identically.
 *
 * - `global: false` — only routes that opt in via `config.rateLimit` are throttled, so the
 *   4–5s polling endpoints are never capped.
 * - `hook: 'preHandler'` — runs after body parsing/validation so the email is available.
 * - keyed on client IP + attempted email: one fat-fingered member behind a shared
 *   NAT/proxy IP can't lock out the household, while per-account guessing is still capped.
 *   (Routes with no email body — e.g. OIDC login — key on IP alone.) Behind a proxy,
 *   set TRUSTED_PROXIES so `req.ip` is the real client.
 *
 * When the cap trips, the plugin throws an error carrying `statusCode: 429`; the central
 * error handler turns that into the app's `RATE_LIMITED` envelope (see error-handler.ts),
 * so a throttle never masquerades as a 500.
 */
export const authRateLimitOptions = {
  global: false,
  hook: 'preHandler' as const,
  keyGenerator: (req: FastifyRequest): string => {
    const body = req.body as { email?: unknown } | undefined;
    const email =
      body && typeof body === 'object' && typeof body.email === 'string'
        ? body.email.trim().toLowerCase().slice(0, 64)
        : '';
    return `${req.ip}|${email}`;
  },
};

/** Per-user companion-EPUB download cap. Frozen constants (issue #146 AC29). */
export const EBOOK_DOWNLOAD_MAX = 10;
export const EBOOK_DOWNLOAD_WINDOW = '1 minute';

/**
 * The key the anonymous/unapproved bucket would use. Unreachable in practice —
 * {@link ebookDownloadAllowList} exempts every caller without a `request.user` — but the plugin
 * computes the key BEFORE evaluating the allowList, so the generator must be total.
 */
export const EBOOK_DOWNLOAD_PLACEHOLDER_KEY = 'unauthenticated';

/**
 * Key the download cap on the USER, not the IP: a household behind one NAT address must not share
 * a bucket, and one member's burst must not throttle another's. `request.user` is attached by
 * `authPlugin`'s `onRequest` hook, which runs before the limiter's `preHandler`.
 */
export const ebookDownloadKeyGenerator = (req: FastifyRequest): string =>
  req.user?.publicId ?? EBOOK_DOWNLOAD_PLACEHOLDER_KEY;

/**
 * Guard precedence over throttling (issue #146 AC37). The limiter runs on `preHandler`, i.e.
 * BEFORE the handler's lexical `requireActiveUser`, so it must never be the thing that answers a
 * caller the guard would refuse — an anonymous, pending or rejected caller must get its
 * deterministic 401/403 no matter how many requests preceded it.
 *
 * Exempting them is safe precisely because they cost nothing: the guard refuses them with zero
 * upstream traffic and zero DB writes. There is deliberately no IP fallback bucket.
 *
 * The predicate is the SHARED `isApprovedUser` — the same one `requireActiveUser` enforces with —
 * so the exemption and the refusal cannot drift apart.
 */
export const ebookDownloadAllowList = (req: FastifyRequest): boolean =>
  !req.user || !isApprovedUser(req.user);

/** The per-route `config.rateLimit` value for the companion-EPUB download proxy. */
export const ebookDownloadRateLimitOptions = {
  max: EBOOK_DOWNLOAD_MAX,
  timeWindow: EBOOK_DOWNLOAD_WINDOW,
  keyGenerator: ebookDownloadKeyGenerator,
  allowList: ebookDownloadAllowList,
};
