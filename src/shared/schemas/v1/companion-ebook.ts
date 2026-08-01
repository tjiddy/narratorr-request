import { z } from 'zod';

// =============================================================================
// VENDORED CONTRACT — Narratorr `/api/v1`, the companion-ebook value object.
//
// Source: narratorr #1961 — narratorr can pair an imported audiobook with a
// companion EPUB and now advertises it publicly. Mirrors narratorr's own
// `src/shared/schemas/v1/companion-ebook.ts` (`companionEbookV1Schema`). Field
// names are verbatim; the `v1XSchema` export naming is our pre-existing house
// style (cf. `v1BookSchema` / `v1SystemSchema`), not a contract divergence.
//
// The value rides TWO surfaces, both declared here and applied there:
//   - nested in the metadata-search `library` annotation (`./metadata.ts`) — the
//     live consumer surface;
//   - top-level on the book DTO (`./books.ts`).
//
// BARE OBJECT, on purpose — the ONE intentional divergence from the producer,
// whose copy bakes in `.nullable()`. Our two use sites need a different tolerance
// (both nullable AND optional, because a pre-#1961 narratorr omits the key
// entirely), so nullability/optionality is applied per use site, never here.
//
// CONSUMER-LENIENT (see CLAUDE.md): NON-`.strict()`. The producer's copy IS
// strict — correct for the side that owns the contract and must fail closed
// rather than leak a path or a filename; wrong for us, where drift on a field we
// don't consume must never 502 a user-facing call.
//
// `sizeBytes` is a plain `z.number()` and must NOT gain `.positive()`, `.min(1)`
// or `.int()`: narratorr deliberately round-trips `sizeBytes: 0` (its guard is
// `!= null`, not truthiness), so any positivity bound would silently discard a
// legitimate zero-byte companion.
// =============================================================================
export const v1CompanionEbookSchema = z.object({
  format: z.literal('epub'),
  sizeBytes: z.number(),
});

export type V1CompanionEbook = z.infer<typeof v1CompanionEbookSchema>;
