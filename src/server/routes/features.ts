import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { AppDeps } from '../services/deps.js';
import { featuresDtoSchema, type FeaturesDto } from '../../shared/schemas/features.js';
import { resolveFeatures } from '../services/feature-state.js';
import { requireActiveUser } from '../plugins/auth.js';

/**
 * `GET /api/features` — the SPA's derived feature state.
 *
 * `requireActiveUser` (not `requireUser`): this is operator config, so a pending/rejected account
 * must not see it. Deliberately NOT folded into `MeDto` — `/api/me` is the SPA bootstrap request
 * and must never depend on a narratorr network probe.
 *
 * The derivation itself lives in `services/feature-state.ts` (issue #146 AC5) and is shared with
 * the companion-EPUB download proxy, so the UI's view of the feature and the server's enforcement
 * of it cannot drift. The route can never 5xx: `resolveFeatures` is fail-closed.
 *
 * UI hiding is NOT authorization — every server route that acts on these flags (the download
 * proxy in #146, send-to-Kindle in #148) must re-check them server-side through the same resolver.
 */
export function registerFeatureRoutes(app: FastifyInstance, deps: AppDeps): void {
  const a = app.withTypeProvider<ZodTypeProvider>();

  a.get(
    '/api/features',
    { schema: { response: { 200: featuresDtoSchema } } },
    async (request): Promise<FeaturesDto> => {
      requireActiveUser(request);
      return resolveFeatures(deps);
    },
  );
}
