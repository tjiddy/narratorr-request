import { describe, it, expect } from 'vitest';
import { humanizeBytes } from './format-bytes';

// The shared core behind `formatDatabaseSize` (System Information) and `formatEbookSize` (the
// companion-ebook size chip). Each consumer's INPUT POLICY is tested with that consumer; what is
// pinned here is the one thing they must agree on — the unit ladder itself.

describe('humanizeBytes', () => {
  it.each([
    [0, '0 B'],
    [1, '1 B'],
    [512, '512 B'],
    [1023, '1023 B'],
  ])('renders %d whole, below 1 KB', (input, expected) => {
    expect(humanizeBytes(input)).toBe(expected);
  });

  it.each([
    [1024, '1.0 KB'],
    [1536, '1.5 KB'],
    [1024 * 1024, '1.0 MB'],
    [5 * 1024 * 1024, '5.0 MB'],
    [3 * 1024 * 1024 * 1024, '3.0 GB'],
    [2 * 1024 ** 4, '2.0 TB'],
  ])('renders %d with exactly one decimal', (input, expected) => {
    expect(humanizeBytes(input)).toBe(expected);
  });

  it('stops climbing at TB rather than inventing a unit', () => {
    expect(humanizeBytes(4096 * 1024 ** 4)).toBe('4096.0 TB');
  });
});
