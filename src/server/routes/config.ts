import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { AppDeps } from '../services/deps.js';
import { publicConfigDtoSchema } from '../../shared/schemas/config.js';

/**
 * Public, pre-auth config surface the SPA reads on boot (both authenticated and unauthenticated
 * tabs) to apply the instance badge (favicon recolor + title prefix). PUBLIC by design — no
 * `requireUser` guard — so it must be listed in the route-guard manifest's `PUBLIC_ALLOWLIST`
 * (fail-closed guardrail #99). Exposes NO secret: only the display-only `instanceBadge`, present
 * only when configured (omitted, not `null`, when unset — per exactOptionalPropertyTypes).
 */
export function registerConfigRoutes(app: FastifyInstance, deps: AppDeps): void {
  const a = app.withTypeProvider<ZodTypeProvider>();

  a.get('/api/config', { schema: { response: { 200: publicConfigDtoSchema } } }, async () => ({
    ...(deps.config.instanceBadge !== undefined && { instanceBadge: deps.config.instanceBadge }),
  }));
}
