import { z } from 'zod';

// =============================================================================
// VENDORED CONTRACT — Narratorr `/api/v1`, capability probe: GET /api/v1/capabilities.
//
// Source: narratorr #1961 — feature discovery at its OWN endpoint, deliberately
// not a new key on `/api/v1/system` (whose five-field build contract is frozen).
// Mirrors narratorr's own `src/shared/schemas/v1/capabilities.ts`.
//
// A `404` is the ONLY "unsupported" signal: a pre-#1961 narratorr has no such
// route. Everything about the BODY is therefore required — `companionEpub.enabled`
// is the entire payload, so a body missing it is provider drift, not an old
// server. It fails this schema, surfaces as a 502 CONTRACT_MISMATCH, and the
// probe must treat that as TRANSIENT (retry), never as "unsupported".
//
// CONSUMER-LENIENT (see CLAUDE.md): NON-`.strict()` at BOTH levels. The producer's
// copy is strict at both — the same producer/consumer asymmetry as
// `./companion-ebook.ts`. A future narratorr adding a second capability alongside
// `companionEpub` must not break us.
// =============================================================================
export const v1CapabilitiesSchema = z.object({
  companionEpub: z.object({ enabled: z.boolean() }),
});

export type V1Capabilities = z.infer<typeof v1CapabilitiesSchema>;
