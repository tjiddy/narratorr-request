import { describe, it, expect } from 'vitest';
import { buildRouteApp } from '../test-support/route-harness.js';
import { publicConfigDtoSchema } from '../../shared/schemas/config.js';
import { registerConfigRoutes } from './config.js';

// The public, pre-auth config surface the SPA reads on boot to apply the instance badge. Two shapes
// matter: the field is present when the badge is configured, and OMITTED (not null) when unset. It
// must expose nothing but `instanceBadge`, and must be reachable without auth (it carries no guard —
// the route-guard manifest test allowlists it).
const get = (app: Awaited<ReturnType<typeof buildRouteApp>>['app']) =>
  app.inject({ method: 'GET', url: '/api/config' });

describe('GET /api/config', () => {
  it('returns { instanceBadge } when the badge is configured', async () => {
    const h = await buildRouteApp({ register: registerConfigRoutes, config: { instanceBadge: 'dev' } });
    try {
      const res = await get(h.app);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ instanceBadge: 'dev' });
      expect(publicConfigDtoSchema.parse(res.json())).toEqual({ instanceBadge: 'dev' });
    } finally {
      await h.app.close();
    }
  });

  it('omits the field entirely when the badge is unset (not null)', async () => {
    const h = await buildRouteApp({ register: registerConfigRoutes });
    try {
      const res = await get(h.app);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toEqual({});
      expect('instanceBadge' in body).toBe(false);
      expect(publicConfigDtoSchema.parse(body)).toEqual({});
    } finally {
      await h.app.close();
    }
  });

  it('is reachable without authentication (no guard)', async () => {
    const h = await buildRouteApp({ register: registerConfigRoutes, config: { instanceBadge: 'dev' } });
    try {
      const res = await get(h.app);
      expect(res.statusCode).not.toBe(401);
    } finally {
      await h.app.close();
    }
  });
});
