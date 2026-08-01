import { describe, it, expect } from 'vitest';
import { v1CompanionEbookSchema } from './companion-ebook.js';

describe('v1CompanionEbookSchema (vendored, consumer-lenient)', () => {
  it('parses the advertised companion value and retains both fields', () => {
    expect(v1CompanionEbookSchema.parse({ format: 'epub', sizeBytes: 123456 })).toEqual({
      format: 'epub',
      sizeBytes: 123456,
    });
  });

  it('retains sizeBytes: 0 (no .positive()/.min(1) — narratorr round-trips a zero-byte companion)', () => {
    expect(v1CompanionEbookSchema.parse({ format: 'epub', sizeBytes: 0 }).sizeBytes).toBe(0);
  });

  it('retains a fractional sizeBytes (plain z.number(), no .int())', () => {
    expect(v1CompanionEbookSchema.parse({ format: 'epub', sizeBytes: 0.5 }).sizeBytes).toBe(0.5);
  });

  it('tolerates an unknown provider field and strips it (non-.strict())', () => {
    expect(v1CompanionEbookSchema.parse({ format: 'epub', sizeBytes: 1, checksum: 'abc' })).toEqual({
      format: 'epub',
      sizeBytes: 1,
    });
  });

  it('rejects a non-epub format and a missing/non-numeric sizeBytes', () => {
    expect(v1CompanionEbookSchema.safeParse({ format: 'pdf', sizeBytes: 1 }).success).toBe(false);
    expect(v1CompanionEbookSchema.safeParse({ format: 'epub' }).success).toBe(false);
    expect(v1CompanionEbookSchema.safeParse({ format: 'epub', sizeBytes: '1' }).success).toBe(false);
  });

  it('is the BARE object — nullability/optionality belong to the use sites, not here', () => {
    // The one intentional divergence from the producer, whose copy bakes in `.nullable()`.
    expect(v1CompanionEbookSchema.safeParse(null).success).toBe(false);
    expect(v1CompanionEbookSchema.safeParse(undefined).success).toBe(false);
  });
});
