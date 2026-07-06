import { describe, it, expect } from 'vitest';
import { DEFAULT_LIMIT, MAX_LIMIT } from '@shared/schemas/v1/common';
import { hasMore, nextLimit, canLoadMore } from './paging';

describe('hasMore', () => {
  it('is false when everything is loaded — including the total === loaded boundary', () => {
    expect(hasMore(50, 50)).toBe(false); // exact boundary
    expect(hasMore(50, 40)).toBe(false); // total below loaded (defensive)
    expect(hasMore(0, 0)).toBe(false); // empty list — no spurious "more"
    expect(hasMore(1, 1)).toBe(false); // single row fully shown
  });

  it('is true when the server reports more rows than are loaded', () => {
    expect(hasMore(50, 51)).toBe(true);
    expect(hasMore(50, 500)).toBe(true);
  });
});

describe('nextLimit', () => {
  it('grows by one default page', () => {
    expect(nextLimit(DEFAULT_LIMIT)).toBe(DEFAULT_LIMIT * 2);
    expect(nextLimit(100)).toBe(100 + DEFAULT_LIMIT);
  });

  it('never asks the server for more than MAX_LIMIT', () => {
    expect(nextLimit(MAX_LIMIT - 10)).toBe(MAX_LIMIT);
    expect(nextLimit(MAX_LIMIT)).toBe(MAX_LIMIT);
    // Walking up from the first page never overshoots the cap.
    let limit = DEFAULT_LIMIT;
    for (let i = 0; i < 100; i++) limit = nextLimit(limit);
    expect(limit).toBe(MAX_LIMIT);
  });
});

describe('canLoadMore', () => {
  it('is true only when more rows exist AND the cap is not yet reached', () => {
    expect(canLoadMore(50, 120, 50)).toBe(true);
    expect(canLoadMore(100, 120, 100)).toBe(true);
  });

  it('is false once everything is loaded', () => {
    expect(canLoadMore(50, 50, 50)).toBe(false);
    expect(canLoadMore(0, 0, DEFAULT_LIMIT)).toBe(false);
    expect(canLoadMore(1, 1, DEFAULT_LIMIT)).toBe(false);
  });

  it('is false at the MAX_LIMIT cap even when the server reports more (paging past 500 is out of scope)', () => {
    expect(canLoadMore(MAX_LIMIT, MAX_LIMIT + 100, MAX_LIMIT)).toBe(false);
  });
});
