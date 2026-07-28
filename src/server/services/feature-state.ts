import { FEATURES_OFF, type FeaturesDto } from '../../shared/schemas/features.js';
import type { ResolvedKindleSender } from '../../shared/schemas/connectors.js';

/**
 * The single place the derived flags are computed (issue #144). Pure, so the invariants can be
 * asserted directly rather than only through a route body — the response schema is non-`.strict()`,
 * so a route-body assertion alone cannot catch a mapper that leaks or drops a field.
 *
 * `ebooksEnabled` is the AND of the Requests-side admin opt-in and narratorr's own capability.
 * `kindleSenderEmail` comes from the resolved sender (#143) ONLY at status `ok` — every recovery
 * status (`notifier-missing` / `not-email` / `config-unusable` / `from-unparseable` /
 * `sender-changed`) and a null selection yield null. The final gate is applied LAST, so a healthy
 * sender behind a disabled feature can never leak a dangling address.
 */
export function deriveFeatures(input: {
  adminToggle: boolean;
  capability: boolean;
  kindleSender: ResolvedKindleSender | null;
}): FeaturesDto {
  const ebooksEnabled = input.adminToggle && input.capability;
  if (!ebooksEnabled) return FEATURES_OFF;
  const kindleSenderEmail = input.kindleSender?.status === 'ok' ? input.kindleSender.confirmedFrom : null;
  return { ebooksEnabled: true, kindleDeliveryAvailable: kindleSenderEmail !== null, kindleSenderEmail };
}

/**
 * The two inputs {@link resolveFeatures} composes. Structural (not the concrete services) so the
 * resolver is unit-testable against stubs, and so `AppDeps` satisfies it by shape — every consumer
 * can pass `deps` straight through.
 */
export interface FeatureStateDeps {
  connectorSettings: { getEbookSettings(): Promise<{ ebooksEnabled: boolean; kindleSender: ResolvedKindleSender | null }> };
  features: { ebooksCapability(): Promise<boolean> };
}

/**
 * Resolve the instance's derived feature state — the ONE composition of "admin opted in" AND
 * "narratorr advertises the capability" (issue #146 AC5). `GET /api/features` (what the SPA sees)
 * and the companion-EPUB download proxy (what the server ENFORCES) both call this, so the two can
 * never disagree about whether the feature is on.
 *
 * Two properties it owns, and one it deliberately does not:
 *   • SHORT-CIRCUIT — a disabled instance generates ZERO narratorr traffic; the capability probe
 *     only runs when the admin toggle is on.
 *   • FAIL-CLOSED — a settings-read failure (or any throw in here) degrades to {@link FEATURES_OFF},
 *     never a 5xx. `/api/features` is polled by every active client; the download route turns the
 *     same outcome into its 403 `EBOOKS_DISABLED`.
 *   • It does NOT re-decide capability-probe outcomes. `FeatureService.ebooksCapability()` is total
 *     and owns the TTL / stale-serve contract, including serving a cached `true` for up to 15
 *     minutes past a failing probe. That stale `true` therefore still permits a download, exactly
 *     as `/api/features` still reports `ebooksEnabled: true` — which is the whole point of one
 *     resolver. The real fail-closed boundary for a dead narratorr is the upstream call itself.
 */
export async function resolveFeatures(deps: FeatureStateDeps): Promise<FeaturesDto> {
  try {
    const { ebooksEnabled: adminToggle, kindleSender } = await deps.connectorSettings.getEbookSettings();
    const capability = adminToggle ? await deps.features.ebooksCapability() : false;
    return deriveFeatures({ adminToggle, capability, kindleSender });
  } catch {
    return FEATURES_OFF;
  }
}
