import { describe, it, expect } from 'vitest';
import {
  BADGE_ACCENT,
  prefixTitle,
  badgedFaviconDataUri,
  decideBadge,
} from './instance-badge.js';

// Decode an `svg+xml` data URI back to its SVG markup so assertions target the decoded color/paths
// rather than the percent-encoded href (the `#` of the accent is encoded as `%23`, per F2).
const decodeDataUri = (uri: string): string => decodeURIComponent(uri.replace(/^data:image\/svg\+xml,/, ''));

// A verbatim glyph path from the served favicon (src/client/public/favicon.svg) — proves the
// recolor preserves the original artwork instead of substituting a different glyph.
const GLYPH_PATH = 'M3 18v-6a9 9 0 0 1 18 0v6';

describe('prefixTitle', () => {
  it('prefixes the badge in `[badge] ` form', () => {
    expect(prefixTitle('Requests', 'dev')).toBe('[dev] Requests');
  });

  it('is idempotent — re-applying the same badge does not double-prefix', () => {
    const once = prefixTitle('Requests', 'dev');
    expect(prefixTitle(once, 'dev')).toBe('[dev] Requests');
  });
});

describe('badgedFaviconDataUri', () => {
  it('is an svg+xml data URI whose decoded SVG carries the violet accent and the original glyph', () => {
    const uri = badgedFaviconDataUri();
    expect(uri.startsWith('data:image/svg+xml,')).toBe(true);
    const svg = decodeDataUri(uri);
    expect(svg).toContain(BADGE_ACCENT); // #8b5cf6
    expect(svg).toContain(GLYPH_PATH);
    // The baseline accent must be gone — it was recolored, not appended.
    expect(svg).not.toContain('#d97706');
  });

  it('recolors to an explicit accent when given one', () => {
    const svg = decodeDataUri(badgedFaviconDataUri('#123456'));
    expect(svg).toContain('#123456');
    expect(svg).toContain(GLYPH_PATH);
  });
});

describe('decideBadge', () => {
  const baseline = { title: 'Requests', faviconHref: '/favicon.svg' };

  it('unset (undefined) → identity no-op: baseline title + favicon href unchanged', () => {
    const out = decideBadge(undefined, baseline);
    expect(out).toEqual(baseline);
  });

  it('empty / whitespace-only → identity no-op', () => {
    expect(decideBadge('', baseline)).toEqual(baseline);
    expect(decideBadge('   ', baseline)).toEqual(baseline);
  });

  it('set → prefixes the title and swaps to the recolored favicon data URI', () => {
    const out = decideBadge('dev', baseline);
    expect(out.title).toBe('[dev] Requests');
    expect(out.faviconHref.startsWith('data:image/svg+xml,')).toBe(true);
    expect(decodeDataUri(out.faviconHref)).toContain(BADGE_ACCENT);
  });

  it('trims a padded badge before prefixing', () => {
    expect(decideBadge('  dev  ', baseline).title).toBe('[dev] Requests');
  });
});
