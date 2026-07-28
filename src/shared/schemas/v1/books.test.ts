import { describe, it, expect } from 'vitest';
import { v1BookSchema, v1AddBookBodySchema } from './books.js';

const book = {
  id: 'bk_abc123',
  title: 'Project Hail Mary',
  authors: [{ name: 'Andy Weir' }],
  narrators: [{ name: 'Ray Porter' }],
  coverUrl: 'https://example.com/cover.jpg',
  asin: 'B08GB58KD5',
  status: 'imported',
  createdAt: '2026-06-13T12:00:00.000Z',
};

describe('v1Book (the bare resource we poll)', () => {
  it('accepts a real book with nullable/absent cover/asin/series', () => {
    expect(v1BookSchema.safeParse(book).success).toBe(true);
    expect(v1BookSchema.safeParse({ ...book, coverUrl: null, asin: null }).success).toBe(true);
    // series is an optional nested object; absent is fine, present must shape-match.
    expect(v1BookSchema.safeParse({ ...book, series: { name: 'Mistborn', position: 1 } }).success).toBe(true);
    expect(v1BookSchema.safeParse({ ...book, series: null }).success).toBe(true);
  });
  it('rejects an unknown status and a numeric id', () => {
    expect(v1BookSchema.safeParse({ ...book, status: 'bogus' }).success).toBe(false);
    expect(v1BookSchema.safeParse({ ...book, id: 7 }).success).toBe(false);
  });
  it('tolerates library people carrying an id (non-strict refs)', () => {
    const withIds = { ...book, authors: [{ id: 'au_1', name: 'Andy Weir' }] };
    expect(v1BookSchema.safeParse(withIds).success).toBe(true);
  });
  it('rejects a non-ISO createdAt but allows it to be absent', () => {
    expect(v1BookSchema.safeParse({ ...book, createdAt: 'yesterday' }).success).toBe(false);
    const { createdAt: _omit, ...noDate } = book;
    expect(v1BookSchema.safeParse(noDate).success).toBe(true);
  });
});

describe('v1Book.companionEbook (#1961)', () => {
  it('retains a companion, retains null, and tolerates the key being absent (old narratorr)', () => {
    expect(v1BookSchema.parse({ ...book, companionEbook: { format: 'epub', sizeBytes: 42 } }).companionEbook).toEqual({
      format: 'epub',
      sizeBytes: 42,
    });
    expect(v1BookSchema.parse({ ...book, companionEbook: null }).companionEbook).toBeNull();
    expect(v1BookSchema.parse(book).companionEbook).toBeUndefined();
  });

  it('never fails the poll on companion drift (the .catch keeps acquiring → available alive)', () => {
    // v1BookSchema backs both addBook() and the poller's getBook(); a CONTRACT_MISMATCH
    // here would 502 the poll and strand the request at `acquiring` forever.
    for (const companionEbook of [{ format: 'pdf' }, 'nope', 7]) {
      const parsed = v1BookSchema.safeParse({ ...book, companionEbook });
      expect(parsed.success).toBe(true);
      expect(parsed.data?.id).toBe('bk_abc123');
      expect(parsed.data?.status).toBe('imported');
      expect(parsed.data?.companionEbook).toBeUndefined();
    }
  });
});

describe('v1AddBookBody (POST /books command)', () => {
  it('requires a non-empty asin and is strict (rejects extra keys)', () => {
    expect(v1AddBookBodySchema.safeParse({ asin: 'B08GB58KD5' }).success).toBe(true);
    expect(v1AddBookBodySchema.safeParse({ asin: '' }).success).toBe(false);
    expect(v1AddBookBodySchema.safeParse({ asin: 'x', extra: 1 }).success).toBe(false);
  });
});
