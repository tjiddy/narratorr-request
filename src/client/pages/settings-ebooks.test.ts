import { describe, it, expect } from 'vitest';
import { initEbooksEnabled, isEbooksDirty, buildEbooksEnabled } from './settings-ebooks';

describe('settings-ebooks — companion-ebook toggle helpers (#144)', () => {
  it('seeds the draft from the saved DTO', () => {
    expect(initEbooksEnabled({ ebooksEnabled: false })).toBe(false);
    expect(initEbooksEnabled({ ebooksEnabled: true })).toBe(true);
  });

  it('is dirty only when the draft differs from the baseline', () => {
    expect(isEbooksDirty(true, false)).toBe(true);
    expect(isEbooksDirty(false, true)).toBe(true);
    expect(isEbooksDirty(false, false)).toBe(false);
    expect(isEbooksDirty(true, true)).toBe(false);
  });

  it('emits an EXPLICIT false rather than dropping it', () => {
    // The load-bearing case. The PUT body is omit-to-keep, so a payload built with a truthiness
    // spread would send `{}` when turning the feature off — a silent no-op the user reads as a
    // successful save until the page reloads.
    expect(buildEbooksEnabled(false)).toEqual({ ebooksEnabled: false });
    expect('ebooksEnabled' in buildEbooksEnabled(false)).toBe(true);
    expect(buildEbooksEnabled(true)).toEqual({ ebooksEnabled: true });
  });

  it('sends ONLY the toggle — no sibling field, and never a narratorr key', () => {
    // Two guarantees at once: omit-to-keep leaves publicUrl/quota/kindleSender untouched, AND the
    // absence of `narratorr` is what keeps the server from retiring its cached capability (and its
    // 15-minute stale budget) on every toggle save.
    for (const draft of [true, false]) {
      expect(Object.keys(buildEbooksEnabled(draft))).toEqual(['ebooksEnabled']);
    }
  });
});
