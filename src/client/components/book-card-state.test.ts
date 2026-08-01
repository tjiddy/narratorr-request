import { describe, it, expect } from 'vitest';
import { resolveBookCardState } from './book-card-state';
import type { V1AudibleResult } from '@shared/schemas/v1/metadata';
import type { V1CompanionEbook } from '@shared/schemas/v1/companion-ebook';

type Library = NonNullable<V1AudibleResult['library']>;

const lib = (status: Library['status'], bookId = 'bk_1') => ({ bookId, status }) satisfies V1AudibleResult['library'];

const EPUB: V1CompanionEbook = { format: 'epub', sizeBytes: 4096 };

/** A library annotation carrying a companion (or explicitly none / an absent key). */
const libWith = (
  status: Library['status'],
  companion: V1CompanionEbook | null | undefined,
  bookId = 'bk_1',
): Library => ({
  bookId,
  status,
  // Spread conditionally so `undefined` genuinely means "key absent" (a pre-#1961 narratorr).
  ...(companion !== undefined && { companionEbook: companion }),
});

describe('resolveBookCardState', () => {
  it('shows the Request button when nothing is known (no library, no request)', () => {
    expect(resolveBookCardState(undefined, undefined)).toEqual({ kind: 'request' });
    expect(resolveBookCardState(null, undefined)).toEqual({ kind: 'request' });
  });

  it('shows the viewer’s own request status when they have one and the book isn’t imported', () => {
    expect(resolveBookCardState(undefined, 'pending')).toEqual({ kind: 'request-status', status: 'pending' });
    expect(resolveBookCardState(null, 'denied')).toEqual({ kind: 'request-status', status: 'denied' });
  });

  it('shows "In library" for an imported book — even over the viewer’s own request row', () => {
    expect(resolveBookCardState(lib('imported'), undefined)).toMatchObject({ kind: 'library', label: 'In library' });
    // imported wins over a stale personal request — the import IS that request's outcome.
    expect(resolveBookCardState(lib('imported'), 'pending')).toMatchObject({ kind: 'library', label: 'In library' });
  });

  it('shows "On the way" for an in-flight library book when the viewer has no request of their own', () => {
    for (const s of ['wanted', 'searching', 'downloading', 'importing'] as const) {
      expect(resolveBookCardState(lib(s), undefined)).toMatchObject({ kind: 'library', label: 'On the way', pulse: true });
    }
  });

  it('lets the viewer’s own request outrank an in-flight library row owned by others', () => {
    expect(resolveBookCardState(lib('downloading'), 'pending')).toEqual({ kind: 'request-status', status: 'pending' });
  });

  it('falls back to the Request button for a failed/missing library book and no personal request', () => {
    expect(resolveBookCardState(lib('failed'), undefined)).toEqual({ kind: 'request' });
    expect(resolveBookCardState(lib('missing'), undefined)).toEqual({ kind: 'request' });
  });
});

// --- the companion-ebook affordance (issue #147) -----------------------------

describe('resolveBookCardState — ebook affordance', () => {
  it('offers the ebook for an imported book with a companion when the feature is on', () => {
    expect(resolveBookCardState(libWith('imported', EPUB, 'bk_abc'), undefined, true)).toEqual({
      kind: 'library',
      label: 'In library',
      variant: 'success',
      pulse: false,
      ebook: { kind: 'available', bookId: 'bk_abc', companion: EPUB },
    });
  });

  it('keeps the imported+ebook branch even when the viewer holds their own request', () => {
    // Precedence is UNCHANGED — the affordance is a property of the imported branch, not a
    // fifth state competing with it.
    for (const status of ['pending', 'denied'] as const) {
      expect(resolveBookCardState(libWith('imported', EPUB), status, true)).toMatchObject({
        kind: 'library',
        label: 'In library',
        ebook: { kind: 'available' },
      });
    }
  });

  it('renders the feature-off card exactly as it does today', () => {
    const off = resolveBookCardState(libWith('imported', EPUB), undefined, false);
    // Byte-identical to the pre-#147 state, plus an affordance that renders nothing.
    expect(off).toEqual({ kind: 'library', label: 'In library', variant: 'success', pulse: false, ebook: { kind: 'none' } });
    // The flag defaults to off, so an un-migrated call site can't light the feature up.
    expect(resolveBookCardState(libWith('imported', EPUB), undefined)).toEqual(off);
  });

  it.each([
    ['an explicit null companion', null],
    ['an ABSENT companionEbook key (pre-#1961 narratorr, or caught drift)', undefined],
  ])('resolves %s to the "No eBook" chip', (_label, companion) => {
    // The two are deliberately indistinguishable — see the contract note in v1/metadata.ts.
    expect(resolveBookCardState(libWith('imported', companion), undefined, true)).toMatchObject({
      ebook: { kind: 'absent' },
    });
  });

  it('treats a zero-byte companion as available — never falsy-dropped', () => {
    const zero: V1CompanionEbook = { format: 'epub', sizeBytes: 0 };
    expect(resolveBookCardState(libWith('imported', zero), undefined, true)).toMatchObject({
      ebook: { kind: 'available', companion: zero },
    });
  });

  it.each([
    ['a path separator', 'bk_bad/part'],
    ['a foreign prefix', 'xx_1'],
    ['an empty id', ''],
    ['a 65-character id', `bk_${'a'.repeat(62)}`],
  ])('downgrades %s to "No eBook" rather than a dead button', (_label, bookId) => {
    expect(resolveBookCardState(libWith('imported', EPUB, bookId), undefined, true)).toMatchObject({
      ebook: { kind: 'absent' },
    });
  });

  it.each(['wanted', 'searching', 'downloading', 'importing'] as const)(
    'offers nothing on the %s (On the way) branch even with a companion annotated',
    (status) => {
      expect(resolveBookCardState(libWith(status, EPUB), undefined, true)).toMatchObject({
        label: 'On the way',
        ebook: { kind: 'none' },
      });
    },
  );

  it.each([
    ['failed', libWith('failed', EPUB)],
    ['missing', libWith('missing', EPUB)],
    ['absent library', undefined],
  ])('carries no affordance at all on the Request branch (%s)', (_label, library) => {
    // Structurally absent IS "none": the `request` state has no action slot to decorate.
    expect(resolveBookCardState(library, undefined, true)).toEqual({ kind: 'request' });
  });
});
