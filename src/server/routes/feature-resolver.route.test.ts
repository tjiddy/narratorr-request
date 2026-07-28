import { describe, it, expect, afterEach, vi } from 'vitest';
import * as featureState from '../services/feature-state.js';
import type * as FeatureStateModule from '../services/feature-state.js';
import { buildRouteApp, type RouteHarness } from '../test-support/route-harness.js';
import { insertUser } from '../test-support/db.js';
import { registerFeatureRoutes } from './features.js';
import { registerEbookRoutes } from './ebooks.js';
import { FEATURES_OFF, type FeaturesDto } from '../../shared/schemas/features.js';

// F12 — the structural receipt for AC5's "one shared resolver".
//
// Two things have to be true, and a call-count assertion only covers the first:
//   1. both handlers CALL `resolveFeatures`; and
//   2. both handlers OBEY what it returns.
//
// Without (2) the receipt is theatre: a handler could call the resolver, discard the result, and
// re-derive the admin-toggle x capability decision inline — which is exactly the drift the
// extraction exists to prevent — and every call-count test would still pass, because the real
// resolver and the duplicated logic agree whenever the backing services are consistent.
//
// So the load-bearing cases below force the resolver's answer to DISAGREE with the backing
// services, in both polarities, and assert the handlers follow the resolver. The mock wraps the
// real implementation by default, so behavior is unchanged except where a case overrides it.
const original = vi.hoisted(() => ({
  resolveFeatures: null as unknown as typeof FeatureStateModule.resolveFeatures,
}));

vi.mock('../services/feature-state.js', async (importOriginal) => {
  const actual = await importOriginal<typeof FeatureStateModule>();
  original.resolveFeatures = actual.resolveFeatures;
  return { ...actual, resolveFeatures: vi.fn(actual.resolveFeatures) };
});

const resolveFeatures = vi.mocked(featureState.resolveFeatures);

const DOWNLOAD_URL = '/api/ebooks/bk_abc/download';

let h: RouteHarness;
afterEach(async () => {
  await h.app.close();
  // `clearAllMocks` resets CALLS but not implementations, so an override set by one case would
  // leak into the next. Put the real implementation back explicitly.
  resolveFeatures.mockImplementation(original.resolveFeatures);
  resolveFeatures.mockClear();
});

/** Build the app with both feature consumers, seeding what the BACKING services report. */
async function build(backing: { ebooksEnabled: boolean; capability: boolean }): Promise<Record<string, string>> {
  h = await buildRouteApp({
    register: (app, deps) => {
      registerFeatureRoutes(app, deps);
      registerEbookRoutes(app, deps);
    },
  });
  h.narratorr.companionEpub = backing.capability;
  await h.connectorSettings.update({ ebooksEnabled: backing.ebooksEnabled });
  const user = await insertUser(h.db, { role: 'user', status: 'active' });
  return h.cookieFor(user);
}

const bothOn = () => build({ ebooksEnabled: true, capability: true });

describe('both feature consumers CALL the one exported resolver (AC5, F12)', () => {
  it('GET /api/features calls resolveFeatures, passing the app dependency graph', async () => {
    const cookies = await bothOn();
    resolveFeatures.mockClear();
    const res = await h.app.inject({ method: 'GET', url: '/api/features', cookies });
    expect(res.statusCode).toBe(200);
    expect(resolveFeatures).toHaveBeenCalledTimes(1);
    // Not just "called" — called with THIS app's wiring, so a stray call to a differently-wired
    // resolver could not satisfy the receipt.
    expect(resolveFeatures).toHaveBeenCalledWith(
      expect.objectContaining({ connectorSettings: h.connectorSettings, features: h.features }),
    );
  });

  it('the companion-EPUB download route calls resolveFeatures on EVERY download', async () => {
    const cookies = await bothOn();
    resolveFeatures.mockClear();
    expect((await h.app.inject({ method: 'GET', url: DOWNLOAD_URL, cookies })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'GET', url: DOWNLOAD_URL, cookies })).statusCode).toBe(200);
    expect(resolveFeatures).toHaveBeenCalledTimes(2);
    expect(resolveFeatures).toHaveBeenCalledWith(
      expect.objectContaining({ connectorSettings: h.connectorSettings, features: h.features }),
    );
  });

  it('the guard runs BEFORE the resolver — an unauthorized caller triggers no feature work at all', async () => {
    await bothOn();
    resolveFeatures.mockClear();
    expect((await h.app.inject({ method: 'GET', url: DOWNLOAD_URL })).statusCode).toBe(401);
    expect(resolveFeatures).not.toHaveBeenCalled();
  });
});

describe('both consumers OBEY the resolver RESULT, not their own copy of the rule (AC5, F12)', () => {
  it('follows the resolver OFF while the backing services both say ON', async () => {
    // Duplicated inline logic would read `ebooksEnabled: true` + `companionEpub: true` and answer
    // "on", so a handler that calls the resolver and discards its result fails here.
    const cookies = await bothOn();
    resolveFeatures.mockResolvedValue(FEATURES_OFF);

    const [download, features] = await Promise.all([
      h.app.inject({ method: 'GET', url: DOWNLOAD_URL, cookies }),
      h.app.inject({ method: 'GET', url: '/api/features', cookies }),
    ]);
    expect(download.statusCode).toBe(403);
    expect(download.json().error.code).toBe('EBOOKS_DISABLED');
    expect(features.json().ebooksEnabled).toBe(false);
    // The enforcement side must not have reached narratorr on a resolver-off answer.
    expect(h.ebookStream.opened).toEqual([]);
  });

  it('follows the resolver ON while the backing admin toggle says OFF', async () => {
    // The mirror image, and the one that actually catches the counterfactual: inline logic reading
    // the (false) admin toggle would refuse the download, so only a handler consuming the
    // resolver's return value can pass.
    const cookies = await build({ ebooksEnabled: false, capability: false });
    const distinctive: FeaturesDto = {
      ebooksEnabled: true,
      kindleDeliveryAvailable: true,
      kindleSenderEmail: 'resolver-only@example.com',
    };
    resolveFeatures.mockResolvedValue(distinctive);

    const [download, features] = await Promise.all([
      h.app.inject({ method: 'GET', url: DOWNLOAD_URL, cookies }),
      h.app.inject({ method: 'GET', url: '/api/features', cookies }),
    ]);
    expect(download.statusCode).toBe(200);
    expect(h.ebookStream.opened).toEqual(['bk_abc']);
    expect(features.json()).toEqual(distinctive);
  });

  it('serializes the resolver DTO verbatim — /api/features never re-derives the payload', async () => {
    // No Kindle sender is configured on the backing services at all, so a re-deriving handler
    // could not produce this address. It can only come from the resolver's return value.
    const cookies = await bothOn();
    const distinctive: FeaturesDto = {
      ebooksEnabled: true,
      kindleDeliveryAvailable: true,
      kindleSenderEmail: 'resolver-only@example.com',
    };
    resolveFeatures.mockResolvedValue(distinctive);

    const res = await h.app.inject({ method: 'GET', url: '/api/features', cookies });
    expect(res.json()).toEqual(distinctive);
    expect((await h.connectorSettings.getEbookSettings()).kindleSender).toBeNull();
  });

  it('re-reads the resolver per request rather than caching the SPA answer', async () => {
    // Same resolver, live: flipping the admin toggle between calls must change BOTH answers.
    const cookies = await bothOn();
    expect((await h.app.inject({ method: 'GET', url: DOWNLOAD_URL, cookies })).statusCode).toBe(200);

    await h.connectorSettings.update({ ebooksEnabled: false });
    const [download, features] = await Promise.all([
      h.app.inject({ method: 'GET', url: DOWNLOAD_URL, cookies }),
      h.app.inject({ method: 'GET', url: '/api/features', cookies }),
    ]);
    expect(download.statusCode).toBe(403);
    expect(download.json().error.code).toBe('EBOOKS_DISABLED');
    expect(features.json().ebooksEnabled).toBe(false);
  });
});
