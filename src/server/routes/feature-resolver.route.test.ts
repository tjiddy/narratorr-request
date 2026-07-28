import { describe, it, expect, afterEach, vi } from 'vitest';
import * as featureState from '../services/feature-state.js';
import { buildRouteApp, type RouteHarness } from '../test-support/route-harness.js';
import { insertUser } from '../test-support/db.js';
import { registerFeatureRoutes } from './features.js';
import { registerEbookRoutes } from './ebooks.js';

// F12 — the STRUCTURAL receipt for AC5's "one shared resolver". A behavioral test (both routes
// agree about the flags) passes just as happily with the AND logic duplicated in each handler,
// which is exactly the drift the extraction exists to prevent. So this file spies on the module
// EXPORT and proves each handler crosses that boundary: the wrapper delegates to the real
// implementation, so observable behavior is unchanged and only the call itself is under test.
vi.mock('../services/feature-state.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/feature-state.js')>();
  return { ...actual, resolveFeatures: vi.fn(actual.resolveFeatures) };
});

const resolveFeatures = vi.mocked(featureState.resolveFeatures);

let h: RouteHarness;
afterEach(async () => {
  await h.app.close();
  vi.clearAllMocks();
});

async function build(): Promise<Record<string, string>> {
  h = await buildRouteApp({
    register: (app, deps) => {
      registerFeatureRoutes(app, deps);
      registerEbookRoutes(app, deps);
    },
  });
  h.narratorr.companionEpub = true;
  await h.connectorSettings.update({ ebooksEnabled: true });
  const user = await insertUser(h.db, { role: 'user', status: 'active' });
  return h.cookieFor(user);
}

describe('both feature consumers go through the ONE exported resolver (AC5, F12)', () => {
  it('GET /api/features calls resolveFeatures', async () => {
    const cookies = await build();
    resolveFeatures.mockClear();
    const res = await h.app.inject({ method: 'GET', url: '/api/features', cookies });
    expect(res.statusCode).toBe(200);
    expect(resolveFeatures).toHaveBeenCalledTimes(1);
  });

  it('the companion-EPUB download route calls resolveFeatures on EVERY download', async () => {
    const cookies = await build();
    resolveFeatures.mockClear();
    expect((await h.app.inject({ method: 'GET', url: '/api/ebooks/bk_abc/download', cookies })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'GET', url: '/api/ebooks/bk_abc/download', cookies })).statusCode).toBe(200);
    expect(resolveFeatures).toHaveBeenCalledTimes(2);
  });

  it('the download route re-checks the flags rather than trusting a prior /api/features answer', async () => {
    // Same resolver, so flipping the admin toggle between calls must change BOTH answers. An
    // implementation that cached the SPA's view would keep serving the download here.
    const cookies = await build();
    expect((await h.app.inject({ method: 'GET', url: '/api/ebooks/bk_abc/download', cookies })).statusCode).toBe(200);

    await h.connectorSettings.update({ ebooksEnabled: false });
    const [download, features] = await Promise.all([
      h.app.inject({ method: 'GET', url: '/api/ebooks/bk_abc/download', cookies }),
      h.app.inject({ method: 'GET', url: '/api/features', cookies }),
    ]);
    expect(download.statusCode).toBe(403);
    expect(download.json().error.code).toBe('EBOOKS_DISABLED');
    expect(features.json().ebooksEnabled).toBe(false);
  });

  it('the guard runs BEFORE the resolver — an unauthorized caller triggers no feature work at all', async () => {
    await build();
    resolveFeatures.mockClear();
    expect((await h.app.inject({ method: 'GET', url: '/api/ebooks/bk_abc/download' })).statusCode).toBe(401);
    expect(resolveFeatures).not.toHaveBeenCalled();
  });
});
