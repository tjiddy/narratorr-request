import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildRouteApp, type RouteHarness } from '../test-support/route-harness.js';
import { registerHealthRoutes } from './health.js';

// The readiness probe a container orchestrator / load balancer polls — both the db:ok → 200 and db:down → 503 branches
// matter, and `narratorrConfigured`/`authMode` must be top-level fields the probe can read.
let h: RouteHarness;
beforeEach(async () => {
  h = await buildRouteApp({ register: registerHealthRoutes });
});
afterEach(async () => {
  await h.app.close();
  vi.restoreAllMocks();
});

const health = () => h.app.inject({ method: 'GET', url: '/api/health' });

describe('GET /api/health', () => {
  it('DB healthy + narratorr configured → 200 ok, top-level narratorrConfigured/authMode', async () => {
    const res = await health();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.db).toBe('ok');
    expect(body.narratorrConfigured).toBe(true);
    expect(body.authMode).toBe(h.config.authMode);
  });

  it('DB healthy + narratorr NOT configured → 200 with narratorrConfigured: false', async () => {
    const u = await buildRouteApp({ register: registerHealthRoutes, narratorrConfigured: false });
    try {
      const res = await u.app.inject({ method: 'GET', url: '/api/health' });
      expect(res.statusCode).toBe(200);
      expect(res.json().narratorrConfigured).toBe(false);
    } finally {
      await u.app.close();
    }
  });

  it('db.run rejects → 503 degraded with db: down, config fields still present', async () => {
    vi.spyOn(h.db, 'run').mockRejectedValue(new Error('db unreachable'));
    const res = await health();
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.status).toBe('degraded');
    expect(body.db).toBe('down');
    // The leak-free deploy signal must still carry the config fields even when degraded.
    expect(body.narratorrConfigured).toBe(true);
    expect(body.authMode).toBe(h.config.authMode);
  });
});
