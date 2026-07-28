import { z } from 'zod';

/**
 * Derived, instance-level feature state for the signed-in SPA (issue #144) — the response of
 * `GET /api/features`.
 *
 * Deliberately NOT part of `MeDto`: `/api/me` is `requireUser` (a pending/rejected account can
 * call it, and operator config must not leak to an unapproved user) and it is the SPA bootstrap
 * request, so it must never depend on a narratorr network probe. This payload is `requireActiveUser`
 * and identical for every active caller — it carries no per-user state (the caller's own Kindle
 * address stays self-scoped on `MeDto`, issue #142).
 *
 * Only DERIVED booleans are exposed, never the raw pieces (admin toggle vs. narratorr capability):
 * a server route that needs to re-check the flags must call the resolver, not trust a
 * client-visible breakdown. Diagnosing *why* ebooks are off is a Settings-page concern.
 *
 * Invariants (enforced where the values are derived — see `deriveFeatures` in
 * `src/server/services/feature-state.ts`, the ONE resolver `/api/features` and the companion-EPUB
 * download proxy both go through): `ebooksEnabled === false` ⇒ `kindleDeliveryAvailable === false`
 * ⇒ `kindleSenderEmail === null`. A disabled feature never carries a dangling address.
 */
export const featuresDtoSchema = z.object({
  /** narratorr's `companionEpub.enabled` capability AND the Requests-side admin opt-in. */
  ebooksEnabled: z.boolean(),
  /** Operator-side Kindle readiness: `ebooksEnabled` AND a healthy (`ok`) Kindle sender. */
  kindleDeliveryAvailable: z.boolean(),
  /** The confirmed From address Kindle deliveries send as, or null when unavailable. */
  kindleSenderEmail: z.string().nullable(),
});

export type FeaturesDto = z.infer<typeof featuresDtoSchema>;

/**
 * The fail-closed payload. Every degraded outcome — a resolver failure, a settings-read failure,
 * a capability probe that can't be resolved — answers with exactly this, so `/api/features` can
 * never 5xx and the SPA's gate defaults to off.
 */
export const FEATURES_OFF: FeaturesDto = {
  ebooksEnabled: false,
  kindleDeliveryAvailable: false,
  kindleSenderEmail: null,
};
