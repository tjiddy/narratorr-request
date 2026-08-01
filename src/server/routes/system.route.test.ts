import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync, rmSync } from 'node:fs';
import { buildRouteApp, type RouteHarness } from '../test-support/route-harness.js';
import { registerSystemRoutes } from './system.js';
import { NarratorrError, type INarratorrClient } from '../services/narratorr-client.js';
import type { V1Book } from '../../shared/schemas/v1/books.js';
import type { V1System } from '../../shared/schemas/v1/system.js';
import { systemInfoSchema } from '../../shared/schemas/system.js';
import type { V1Capabilities } from '../../shared/schemas/v1/capabilities.js';

// A narratorr client whose only interesting method is getSystem — the System card never
// touches the book methods, so they reject if (unexpectedly) reached.
function systemClient(getSystem: () => Promise<V1System>): INarratorrClient {
  return {
    async searchMetadata() {
      return [];
    },
    async addBook(): Promise<V1Book> {
      throw new Error('n/a');
    },
    async getBook(): Promise<V1Book> {
      throw new Error('n/a');
    },
    async getCapabilities(): Promise<V1Capabilities> {
      throw new Error('n/a');
    },
    getSystem,
  };
}

const getSystem = (headers: Record<string, string> = {}) =>
  h.app.inject({ method: 'GET', url: '/api/admin/system', headers });

let h: RouteHarness;
afterEach(async () => {
  await h.app.close();
  vi.restoreAllMocks();
});

// AC1 — admin-only authz boundary.
describe('GET /api/admin/system — authz', () => {
  beforeEach(async () => {
    h = await buildRouteApp({ register: registerSystemRoutes, enableTestRoleOverride: true });
  });

  it('anon → 401 UNAUTHORIZED', async () => {
    const res = await getSystem();
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
  });

  it('active non-admin → 403 FORBIDDEN', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/admin/system', headers: h.asRole('user') });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('admin → 200', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/admin/system', headers: h.asRole('admin') });
    expect(res.statusCode).toBe(200);
  });
});

describe('GET /api/admin/system — response contract', () => {
  beforeEach(async () => {
    h = await buildRouteApp({ register: registerSystemRoutes, enableTestRoleOverride: true });
  });

  it('200 body matches the Response Contract exactly (Zod-validated)', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/admin/system', headers: h.asRole('admin') });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // The route serializes through systemInfoSchema; re-parse to pin the wire shape.
    expect(systemInfoSchema.safeParse(body).success).toBe(true);
    expect(typeof body.version).toBe('string');
    expect(body.builtAt === null || typeof body.builtAt === 'string').toBe(true);
    expect(body.node).toBe(process.version);
    expect(typeof body.os).toBe('string');
    expect(body.os.length).toBeGreaterThan(0);
    // Harness default databasePath is ':memory:' (not a real file) → null, never a 500.
    expect(body.databaseSizeBytes).toBeNull();
  });
});

// AC4/AC5 — narratorr.state mapping; the endpoint stays 200 in EVERY narratorr case.
describe('GET /api/admin/system — narratorr reachability', () => {
  it('reachable → state "connected" with version', async () => {
    h = await buildRouteApp({
      register: registerSystemRoutes,
      enableTestRoleOverride: true,
      narratorr: systemClient(async () => ({ version: 'v1.0.0', commit: 'abc1234' })),
    });
    const res = await getSystem(h.asRole('admin'));
    expect(res.statusCode).toBe(200);
    expect(res.json().narratorr).toMatchObject({ state: 'connected', version: 'v1.0.0', commit: 'abc1234' });
  });

  // Both status-0 classes land the same way — #213 split NETWORK into NETWORK/TIMEOUT and the
  // System card must not start distinguishing them.
  it.each([
    ['NETWORK', new NarratorrError(0, 'NETWORK', 'unreachable')],
    ['TIMEOUT', new NarratorrError(0, 'TIMEOUT', 'timed out')],
  ])('%s error → state "unreachable", our-side fields still present', async (_label, err) => {
    h = await buildRouteApp({
      register: registerSystemRoutes,
      enableTestRoleOverride: true,
      narratorr: systemClient(async () => {
        throw err;
      }),
    });
    const res = await getSystem(h.asRole('admin'));
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.narratorr.state).toBe('unreachable');
    expect(typeof body.node).toBe('string');
    expect(typeof body.os).toBe('string');
  });

  it('non-2xx upstream (e.g. HTTP_500) → state "unreachable"', async () => {
    h = await buildRouteApp({
      register: registerSystemRoutes,
      enableTestRoleOverride: true,
      narratorr: systemClient(async () => {
        throw new NarratorrError(500, 'HTTP_500', 'boom');
      }),
    });
    const res = await getSystem(h.asRole('admin'));
    expect(res.statusCode).toBe(200);
    expect(res.json().narratorr.state).toBe('unreachable');
  });

  it('not configured → state "not_configured", no version', async () => {
    h = await buildRouteApp({
      register: registerSystemRoutes,
      enableTestRoleOverride: true,
      narratorrConfigured: false,
    });
    const res = await getSystem(h.asRole('admin'));
    expect(res.statusCode).toBe(200);
    const { narratorr } = res.json();
    expect(narratorr.state).toBe('not_configured');
    expect(narratorr.version).toBeUndefined();
  });

  it('contract mismatch → state "unavailable" (502 caught internally, never surfaced)', async () => {
    h = await buildRouteApp({
      register: registerSystemRoutes,
      enableTestRoleOverride: true,
      narratorr: systemClient(async () => {
        throw new NarratorrError(200, 'CONTRACT_MISMATCH', 'bad body');
      }),
    });
    const res = await getSystem(h.asRole('admin'));
    expect(res.statusCode).toBe(200);
    expect(res.json().narratorr.state).toBe('unavailable');
  });
});

// AC2/B5 — positive path: a real DB file reports its byte length (the null-producing
// paths below don't prove databaseSizeBytes is ever populated from fs.stat).
describe('GET /api/admin/system — database size (regular file)', () => {
  const dbPath = join(tmpdir(), `sys-db-size-${process.pid}.db`);
  afterEach(() => rmSync(dbPath, { force: true }));

  it('regular DB file → databaseSizeBytes equals the file byte length, 200', async () => {
    writeFileSync(dbPath, 'x'.repeat(4096)); // 4096 ASCII bytes
    h = await buildRouteApp({
      register: registerSystemRoutes,
      enableTestRoleOverride: true,
      config: { databasePath: dbPath },
    });
    const res = await getSystem(h.asRole('admin'));
    expect(res.statusCode).toBe(200);
    expect(res.json().databaseSizeBytes).toBe(4096);
  });
});

// AC6 — db-size resilience: null (and 200) on any non-regular-file path, never a 500.
describe('GET /api/admin/system — database size resilience', () => {
  it('directory path (ENOTDIR/EISDIR shape) → databaseSizeBytes null, still 200', async () => {
    h = await buildRouteApp({
      register: registerSystemRoutes,
      enableTestRoleOverride: true,
      config: { databasePath: tmpdir() }, // a directory, not a regular file
    });
    const res = await getSystem(h.asRole('admin'));
    expect(res.statusCode).toBe(200);
    expect(res.json().databaseSizeBytes).toBeNull();
  });

  it('missing file path (ENOENT) → databaseSizeBytes null, still 200', async () => {
    h = await buildRouteApp({
      register: registerSystemRoutes,
      enableTestRoleOverride: true,
      config: { databasePath: `${tmpdir()}/does-not-exist-${process.pid}.db` },
    });
    const res = await getSystem(h.asRole('admin'));
    expect(res.statusCode).toBe(200);
    expect(res.json().databaseSizeBytes).toBeNull();
  });
});
