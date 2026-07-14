import { z } from 'zod';

// Response contract for OUR public, unauthenticated `GET /api/config` — the minimal config surface
// the SPA reads on boot (both signed-in and signed-out tabs) to apply the instance badge. Lives in
// `src/shared/schemas/` so the server route and the client share one shape.
//
// Minimal BY DESIGN: this route is pre-auth, so it must expose NO secret (the env surface is
// otherwise auth+secrets). `instanceBadge` is a display-only tab badge (favicon accent recolor +
// title prefix) distinguishing a dev instance from prod. Present only when configured; OMITTED
// (not `null`) when unset, matching the repo's `exactOptionalPropertyTypes` optionality convention.
export const publicConfigDtoSchema = z.object({
  instanceBadge: z.string().optional(),
});

export type PublicConfigDto = z.infer<typeof publicConfigDtoSchema>;
