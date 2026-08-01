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

// ---- The cross-app integration sweep (issue #150) ----------------------------

/**
 * The values a cross-app scenario injects on top of the closed list above. Same provenance rule:
 * every one is configured or injected by the suite, never caller-owned text, and no fixture title
 * or book id contains one as a substring.
 *
 * The narratorr coordinates are supplied rather than taken from the constants above because the
 * fake narratorr binds an EPHEMERAL port — the sentinel has to be the URL actually configured, or
 * the sweep would assert about a host nothing ever talked to.
 */
export interface IntegrationSentinelValues {
  /** The configured base URL of the live fake narratorr (`http://127.0.0.1:<port>`). */
  narratorrBaseUrl: string;
  /** The caller's own Kindle address — carried ONLY by `GET`/`PATCH /api/me`. */
  kindleAddress: string;
  /** The SMTP username `buildKindleTransport` must present. */
  smtpUser: string;
  /** The SMTP password `buildKindleTransport` must present. */
  smtpPass: string;
}

/**
 * Compose the shared closed list with a scenario's own injected values. The shared list is
 * EXTENDED, never mutated — its two existing consumers keep exactly the sentinels they had.
 */
export function integrationSentinels(
  v: IntegrationSentinelValues,
): ReadonlyArray<readonly [label: string, value: string]> {
  return [
    ...LEAK_SENTINELS,
    ['the live narratorr base url', v.narratorrBaseUrl],
    ['the live narratorr host:port', new URL(v.narratorrBaseUrl).host],
    ['the caller’s kindle address', v.kindleAddress],
    ['the smtp username', v.smtpUser],
    ['the smtp password', v.smtpPass],
  ];
}

/**
 * AC21: the three swept surfaces — our response body, ALL of our response headers, and every
 * captured application log line.
 *
 * The log haystack is asserted RAW (the serialized lines, joined) rather than field-wise, so a
 * sentinel nested inside a structured field or an error `cause` cannot slip past. That matters
 * more than the body assertion here: `fastify-type-provider-zod` parses handler returns through
 * NON-`.strict()` schemas, so Zod strips unknown keys and a body-only sweep can pass over a
 * genuinely leaking mapper (curated learning `nonstrict-response-schema-masks-mapper-leak`).
 *
 * The fakes' OWN capture is deliberately not a swept surface: the credentials legitimately travel
 * to them on the wire (`X-Api-Key` to fake narratorr, SMTP `AUTH` to fake SMTP), and sweeping one
 * would contradict the positive receipts AC1b/AC2b require.
 */
export function expectNoLeaksAcross(
  sentinels: ReadonlyArray<readonly [label: string, value: string]>,
  surfaces: { body: string; headers: Record<string, unknown>; logs: string },
  where: string,
  opts: ExpectNoLeaksOpts = {},
): void {
  const headers = JSON.stringify(surfaces.headers);
  const exempt = new Set(opts.bodyExempt ?? []);
  for (const [label, value] of sentinels) {
    // The exemption is PER VALUE and applies to the BODY ONLY. `GET`/`PATCH /api/me` legitimately
    // return the caller's own Kindle address, but nothing makes them a licence to carry the
    // narratorr key, a media path or the SMTP credentials — so every other sentinel keeps its body
    // assertion, and the exempted value is still swept in the headers and the logs.
    if (!exempt.has(value)) {
      expect(surfaces.body.includes(value), `${where}: leaked ${label} in the response body`).toBe(false);
    }
    expect(headers.includes(value), `${where}: leaked ${label} in a response header`).toBe(false);
    expect(surfaces.logs.includes(value), `${where}: leaked ${label} in an application log line`).toBe(false);
  }
}

export interface ExpectNoLeaksOpts {
  /**
   * Sentinel VALUES this response's body is the documented carrier of — the only per-response
   * narrowing the sweep allows. Never widen this to a whole response: exempting a surface exempts
   * every secret on it.
   */
  bodyExempt?: readonly string[];
}
