import { describe, it, expect } from 'vitest';
import { v1AudibleResultSchema } from './metadata.js';

describe('v1 audible result', () => {
  it('accepts a minimal result and a fully-populated one (cover + nested series)', () => {
    expect(v1AudibleResultSchema.safeParse({ asin: 'B0', title: 't', authors: [], narrators: [], cover: null }).success).toBe(true);
    const full = { asin: 'B0', title: 't', authors: [{ name: 'a', asin: 'X' }], narrators: [{ name: 'n' }], cover: 'u', series: { name: 's', position: 2.5 }, publishedDate: '2020', language: 'english' };
    expect(v1AudibleResultSchema.safeParse(full).success).toBe(true);
  });
  it('requires the live `cover` field (rejects the old coverUrl shape)', () => {
    expect(v1AudibleResultSchema.safeParse({ asin: 'B0', title: 't', authors: [], narrators: [], coverUrl: 'x' }).success).toBe(false);
  });

  describe('library cross-reference (#1537)', () => {
    const base = { asin: 'B0', title: 't', authors: [], narrators: [], cover: null };

    it('parses a result carrying a valid library annotation', () => {
      const r = v1AudibleResultSchema.parse({ ...base, library: { bookId: 'bk_x', status: 'imported' } });
      expect(r.library).toEqual({ bookId: 'bk_x', status: 'imported' });
    });

    it('accepts library absent or explicitly null (the "not owned" signals)', () => {
      expect(v1AudibleResultSchema.parse(base).library).toBeUndefined();
      expect(v1AudibleResultSchema.parse({ ...base, library: null }).library).toBeNull();
    });

    it('degrades a malformed/unknown-status annotation to undefined instead of failing the whole result', () => {
      // Best-effort decoration: provider drift on this field must never 502 a search.
      expect(v1AudibleResultSchema.parse({ ...base, library: { bookId: 'bk_x', status: 'bogus' } }).library).toBeUndefined();
      expect(v1AudibleResultSchema.parse({ ...base, library: { status: 'imported' } }).library).toBeUndefined();
      // ...but the rest of the result still parses cleanly.
      expect(v1AudibleResultSchema.parse({ ...base, library: 'garbage' }).title).toBe('t');
    });

    describe('companionEbook (#1961)', () => {
      it('parses and RETAINS a nested companion annotation', () => {
        // The headline regression: before this field was declared, a non-strict parse
        // silently STRIPPED it and nothing downstream could ever see it.
        const r = v1AudibleResultSchema.parse({
          ...base,
          library: { bookId: 'bk_x', status: 'imported', companionEbook: { format: 'epub', sizeBytes: 42 } },
        });
        expect(r.library).toEqual({
          bookId: 'bk_x',
          status: 'imported',
          companionEbook: { format: 'epub', sizeBytes: 42 },
        });
      });

      it('retains an explicit null (the "no companion ebook" signal)', () => {
        const r = v1AudibleResultSchema.parse({
          ...base,
          library: { bookId: 'bk_x', status: 'imported', companionEbook: null },
        });
        expect(r.library?.companionEbook).toBeNull();
      });

      it('parses an old-narratorr annotation carrying no companionEbook key at all', () => {
        const r = v1AudibleResultSchema.parse({ ...base, library: { bookId: 'bk_x', status: 'imported' } });
        expect(r.library?.bookId).toBe('bk_x');
        expect(r.library?.status).toBe('imported');
        expect(r.library?.companionEbook).toBeUndefined();
      });

      it('confines companion drift to the companion field (the INNER .catch is load-bearing)', () => {
        // Without the inner `.catch(undefined)`, each of these fails the whole `library`
        // object, the OUTER catch swallows it, and the "In library" / "On the way" badge
        // silently regresses to "not owned" for every result.
        for (const companionEbook of [{ format: 'pdf', sizeBytes: 1 }, 'nope', { format: 'epub' }]) {
          const r = v1AudibleResultSchema.parse({
            ...base,
            library: { bookId: 'bk_x', status: 'imported', companionEbook },
          });
          expect(r.library?.bookId).toBe('bk_x');
          expect(r.library?.status).toBe('imported');
          expect(r.library?.companionEbook).toBeUndefined();
        }
      });
    });
  });
});
