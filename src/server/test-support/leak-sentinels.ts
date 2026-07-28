import { expect } from 'vitest';

/**
 * The AC38 leak sentinels for the companion-EPUB download proxy (issue #146) — a CLOSED list,
 * and the finite predicate AC32's "every response branch" sweep is defined against.
 *
 * Provenance is what makes the sweep safe to apply to EVERY response: each entry is a value the
 * tests inject upstream or configure, never caller-owned text, so the assertion can't trip on a
 * book title someone chose. Test titles and book ids are picked to contain none of these
 * substrings.
 *
 * Lives in test-support (not beside one test file) so the `inject()` file and the real-socket file
 * sweep against the same list — importing one test file from another would re-run its suite.
 */
export const NARRATORR_BASE_URL = 'http://narratorr.internal:8123';
export const NARRATORR_HOST_PORT = 'narratorr.internal:8123';
export const NARRATORR_API_KEY = 'sk-leak-sentinel-key';
export const UPSTREAM_POSIX_PATH = '/var/lib/narratorr/media/Secret.epub';
export const UPSTREAM_WINDOWS_PATH = 'C:\\narratorr\\media\\Secret.epub';
export const UPSTREAM_UNC_PATH = '\\\\host\\share\\Secret.epub';
export const UPSTREAM_DISPOSITION_NAME = 'upstream-chosen-name.epub';

export const LEAK_SENTINELS: ReadonlyArray<readonly [label: string, value: string]> = [
  ['the narratorr api key', NARRATORR_API_KEY],
  ['the narratorr base url', NARRATORR_BASE_URL],
  ['the narratorr host:port', NARRATORR_HOST_PORT],
  ['the /api/v1 path prefix', '/api/v1'],
  ['a POSIX media path', UPSTREAM_POSIX_PATH],
  ['a Windows media path', UPSTREAM_WINDOWS_PATH],
  ['a UNC media path', UPSTREAM_UNC_PATH],
  ['the upstream content-disposition filename', UPSTREAM_DISPOSITION_NAME],
];

/** AC32: no sentinel may appear in the body or in ANY response header, on ANY branch. */
export function expectNoLeaks(body: string, headers: Record<string, unknown>, where: string): void {
  const haystack = `${body}\n${JSON.stringify(headers)}`;
  for (const [label, value] of LEAK_SENTINELS) {
    expect(haystack.includes(value), `${where}: leaked ${label}`).toBe(false);
  }
}
