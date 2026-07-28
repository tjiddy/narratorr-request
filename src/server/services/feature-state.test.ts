import { describe, it, expect, vi } from 'vitest';
import { deriveFeatures, resolveFeatures, type FeatureStateDeps } from './feature-state.js';
import { FEATURES_OFF, featuresDtoSchema } from '../../shared/schemas/features.js';
import type { ResolvedKindleSender } from '../../shared/schemas/connectors.js';

// The ONE shared feature resolver (issue #146 AC5). `GET /api/features` and the companion-EPUB
// download proxy both call `resolveFeatures`, so the admin-toggle x capability decision cannot
// drift between what the UI shows and what the server enforces. `deriveFeatures` (issue #144)
// moved here with it — the response schema is non-`.strict()`, so a route-body assertion alone
// cannot prove the derivation is right; it is pinned directly.

const ok: ResolvedKindleSender = {
  notifierId: 'nf_1',
  confirmedFrom: 'bot@ex.com',
  status: 'ok',
  currentFrom: 'bot@ex.com',
};

describe('deriveFeatures (the derivation itself)', () => {
  it('ANDs the two flags', () => {
    expect(deriveFeatures({ adminToggle: true, capability: true, kindleSender: null }).ebooksEnabled).toBe(true);
    for (const [adminToggle, capability] of [
      [true, false],
      [false, true],
      [false, false],
    ] as const) {
      expect(deriveFeatures({ adminToggle, capability, kindleSender: ok })).toEqual(FEATURES_OFF);
    }
  });

  it('yields the confirmed address only at status `ok`', () => {
    expect(deriveFeatures({ adminToggle: true, capability: true, kindleSender: ok })).toEqual({
      ebooksEnabled: true,
      kindleDeliveryAvailable: true,
      kindleSenderEmail: 'bot@ex.com',
    });
    for (const status of [
      'notifier-missing',
      'not-email',
      'config-unusable',
      'from-unparseable',
      'sender-changed',
    ] as const) {
      expect(deriveFeatures({ adminToggle: true, capability: true, kindleSender: { ...ok, status } })).toEqual({
        ebooksEnabled: true,
        kindleDeliveryAvailable: false,
        kindleSenderEmail: null,
      });
    }
  });

  it('holds the invariant chain for every input combination', () => {
    for (const adminToggle of [true, false]) {
      for (const capability of [true, false]) {
        for (const kindleSender of [null, ok, { ...ok, status: 'sender-changed' as const }]) {
          const dto = deriveFeatures({ adminToggle, capability, kindleSender });
          if (!dto.ebooksEnabled) expect(dto.kindleDeliveryAvailable).toBe(false);
          if (!dto.kindleDeliveryAvailable) expect(dto.kindleSenderEmail).toBeNull();
          expect(featuresDtoSchema.parse(dto)).toEqual(dto);
        }
      }
    }
  });
});

/** A resolver wired to stubs, so each input can fail independently of any route. */
function stubDeps(over: {
  ebooksEnabled?: boolean;
  kindleSender?: ResolvedKindleSender | null;
  settingsError?: Error;
  capability?: boolean;
  capabilityError?: Error;
}) {
  const getEbookSettings = vi.fn(async () => {
    if (over.settingsError) throw over.settingsError;
    return { ebooksEnabled: over.ebooksEnabled ?? false, kindleSender: over.kindleSender ?? null };
  });
  const ebooksCapability = vi.fn(async () => {
    if (over.capabilityError) throw over.capabilityError;
    return over.capability ?? false;
  });
  const deps: FeatureStateDeps = {
    connectorSettings: { getEbookSettings },
    features: { ebooksCapability },
  };
  return { deps, getEbookSettings, ebooksCapability };
}

describe('resolveFeatures (the shared AND, AC5/AC7)', () => {
  it('is ON only when both the admin toggle and the capability are true', async () => {
    const { deps } = stubDeps({ ebooksEnabled: true, capability: true, kindleSender: ok });
    expect(await resolveFeatures(deps)).toEqual({
      ebooksEnabled: true,
      kindleDeliveryAvailable: true,
      kindleSenderEmail: 'bot@ex.com',
    });
  });

  it('short-circuits: a toggled-off instance NEVER probes narratorr', async () => {
    const { deps, ebooksCapability } = stubDeps({ ebooksEnabled: false, capability: true });
    expect(await resolveFeatures(deps)).toEqual(FEATURES_OFF);
    expect(ebooksCapability).not.toHaveBeenCalled();
  });

  it('is off when the capability is false, from the other side of the AND', async () => {
    const { deps, ebooksCapability } = stubDeps({ ebooksEnabled: true, capability: false, kindleSender: ok });
    expect(await resolveFeatures(deps)).toEqual(FEATURES_OFF);
    expect(ebooksCapability).toHaveBeenCalledTimes(1);
  });

  it('fails CLOSED when the settings read throws — never a rejection', async () => {
    const { deps } = stubDeps({ settingsError: new Error('db gone') });
    await expect(resolveFeatures(deps)).resolves.toEqual(FEATURES_OFF);
  });

  it('fails CLOSED when the capability resolver throws (it is total in production, but still)', async () => {
    const { deps } = stubDeps({ ebooksEnabled: true, capabilityError: new Error('boom') });
    await expect(resolveFeatures(deps)).resolves.toEqual(FEATURES_OFF);
  });

  it('passes a STALE `true` through without re-deciding it (AC7s stated consequence)', async () => {
    // `FeatureService` owns the TTL / 15-minute stale window and is total; the resolver must not
    // second-guess a cached `true` served past a failing probe, or enforcement would disagree
    // with what `/api/features` reports to the same caller at the same moment.
    const { deps } = stubDeps({ ebooksEnabled: true, capability: true });
    expect((await resolveFeatures(deps)).ebooksEnabled).toBe(true);
  });
});
