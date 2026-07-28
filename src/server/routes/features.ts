import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { AppDeps } from '../services/deps.js';
import { featuresDtoSchema, FEATURES_OFF, type FeaturesDto } from '../../shared/schemas/features.js';
import type { ResolvedKindleSender } from '../../shared/schemas/connectors.js';
import { requireActiveUser } from '../plugins/auth.js';

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
 * `GET /api/features` — the SPA's derived feature state.
 *
 * `requireActiveUser` (not `requireUser`): this is operator config, so a pending/rejected account
 * must not see it. Deliberately NOT folded into `MeDto` — `/api/me` is the SPA bootstrap request
 * and must never depend on a narratorr network probe.
 *
 * The route can never 5xx: a resolver failure OR a settings-read failure degrades to the
 * fail-closed payload. UI hiding is NOT authorization — every server route that acts on these
 * flags (the download proxy in #146, send-to-Kindle in #148) must re-check them server-side.
 */
export function registerFeatureRoutes(app: FastifyInstance, deps: AppDeps): void {
  const a = app.withTypeProvider<ZodTypeProvider>();

  a.get(
    '/api/features',
    { schema: { response: { 200: featuresDtoSchema } } },
    async (request): Promise<FeaturesDto> => {
      requireActiveUser(request);
      try {
        const { ebooksEnabled: adminToggle, kindleSender } = await deps.connectorSettings.getEbookSettings();
        // Short-circuit: a disabled instance generates ZERO narratorr traffic. The probe only
        // runs when the admin has opted in.
        const capability = adminToggle ? await deps.features.ebooksCapability() : false;
        return deriveFeatures({ adminToggle, capability, kindleSender });
      } catch {
        return FEATURES_OFF;
      }
    },
  );
}
