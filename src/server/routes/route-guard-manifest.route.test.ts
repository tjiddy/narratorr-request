import { describe, it, expect } from 'vitest';
import type { FastifyInstance, RouteOptions } from 'fastify';
import { buildRouteApp } from '../test-support/route-harness.js';
import type { AppDeps } from '../services/deps.js';
import { registerRoutes } from './index.js';

// Route-guard coverage guardrail (#99). Authentication is attach-only (`authPlugin`'s onRequest
// hook only sets `request.user`, it never denies); authorization is enforced per-route by calling
// `requireUser` / `requireActiveUser` / `requireAdmin` INSIDE each handler. Nothing structural
// stops a future route from shipping with no guard — it would be silently public (fail-open).
//
// This test drives the CENTRAL `registerRoutes()` surface and partitions every registered route
// into exactly two buckets: an explicit public allowlist, or "references a guard". A new route
// that is neither fails here (fail-closed), so a new route file is covered automatically.
//
// Detection is STRUCTURAL (`handler.toString()` references a guard), not a dynamic 401 sweep:
// guards run AFTER Fastify schema validation, so a required-body route would 400 before its guard
// ever ran, masking a genuinely unguarded route. The structural check is robust to that seam.

/** Guards are direct handler calls today; match the identifier in the handler source. */
const GUARD_RE = /require(User|ActiveUser|Admin)\b/;

/**
 * The public (pre-auth) surface — hard-coded here, NOT derived from the routes under test, so
 * adding a route cannot silently expand what counts as "public" (AC#4). Matched on (method, url).
 */
const PUBLIC_ALLOWLIST: ReadonlyArray<{ method: string; url: string }> = [
  { method: 'GET', url: '/api/health' },
  { method: 'GET', url: '/api/auth/providers' },
  { method: 'POST', url: '/api/auth/local/signup' },
  { method: 'POST', url: '/api/auth/local/login' },
  { method: 'GET', url: '/api/auth/oidc/:provider/login' },
  { method: 'GET', url: '/api/auth/oidc/:provider/callback' },
  { method: 'POST', url: '/api/auth/logout' },
];

/** Only real request verbs matter; Fastify auto-adds a HEAD twin for every GET (shared handler). */
const HTTP_VERBS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

interface CollectedRoute {
  method: string;
  url: string;
  handler: unknown;
}

/**
 * Boot the real app via the shared route harness and enumerate the full route surface through an
 * `onRoute` collector registered BEFORE `registerRoutes()` (onRoute only fires for routes added
 * after it, in the same encapsulation context). `extra` lets a test append a throwaway route to
 * prove the classification catches an unclassified newcomer.
 */
async function collectRoutes(
  extra?: (app: FastifyInstance, deps: AppDeps) => void,
): Promise<CollectedRoute[]> {
  const raw: Array<{ method: string | string[]; url: string; handler: unknown }> = [];
  const h = await buildRouteApp({
    register: (app, deps) => {
      app.addHook('onRoute', (r: RouteOptions) => {
        raw.push({ method: r.method, url: r.url, handler: r.handler });
      });
      registerRoutes(app, deps);
      extra?.(app, deps);
    },
  });
  await h.app.close();

  // Flatten multi-method registrations and drop Fastify's auto-added HEAD/OPTIONS twins so a GET
  // route is classified once by its own handler (the twin shares that handler anyway).
  const out: CollectedRoute[] = [];
  for (const r of raw) {
    for (const m of Array.isArray(r.method) ? r.method : [r.method]) {
      const method = String(m).toUpperCase();
      if (!HTTP_VERBS.has(method)) continue;
      out.push({ method, url: r.url, handler: r.handler });
    }
  }
  return out;
}

const isPublic = (r: CollectedRoute): boolean =>
  PUBLIC_ALLOWLIST.some((p) => p.method === r.method && p.url === r.url);

const isGuarded = (r: CollectedRoute): boolean => GUARD_RE.test(String(r.handler));

describe('route-guard coverage manifest', () => {
  it('classifies every registered route as public-allowlisted XOR guard-referencing (AC#1, AC#2)', async () => {
    const routes = await collectRoutes();
    // The harness registers local auth (localAuth: true) and the OIDC pair unconditionally, so the
    // full surface is present. A bare-minimum surface would mean the collector saw nothing.
    expect(routes.length).toBeGreaterThan(0);

    // Exhaustive partition: each route must be in EXACTLY one bucket. Both-false = an unclassified
    // (silently public) route — the failure this guardrail exists to catch. Both-true would mean an
    // allowlisted route also calls a guard (a contradiction to fix).
    const unclassified = routes.filter((r) => !isPublic(r) && !isGuarded(r));
    const doubleClassified = routes.filter((r) => isPublic(r) && isGuarded(r));

    expect(
      unclassified,
      `Route(s) neither on the public allowlist nor referencing a guard ` +
        `(requireUser/requireActiveUser/requireAdmin). Add a guard, or add to PUBLIC_ALLOWLIST if ` +
        `deliberately public:\n${unclassified.map((r) => `  ${r.method} ${r.url}`).join('\n')}`,
    ).toEqual([]);
    expect(
      doubleClassified,
      `Route(s) both allowlisted-public AND guard-referencing — resolve the contradiction:\n` +
        `${doubleClassified.map((r) => `  ${r.method} ${r.url}`).join('\n')}`,
    ).toEqual([]);
  });

  it('every allowlisted route is actually registered (allowlist has no stale entries)', async () => {
    const routes = await collectRoutes();
    const missing = PUBLIC_ALLOWLIST.filter(
      (p) => !routes.some((r) => r.method === p.method && r.url === p.url),
    );
    expect(
      missing,
      `Allowlist entries not present in the registered surface (stale allowlist):\n` +
        `${missing.map((p) => `  ${p.method} ${p.url}`).join('\n')}`,
    ).toEqual([]);
  });

  it('flags a newly-added unguarded, non-allowlisted route (guards the guardrail — AC#1)', async () => {
    const routes = await collectRoutes((app) => {
      // A throwaway route with no guard call and not on the allowlist — exactly the fail-open shape
      // the manifest must catch. If the classification silently passed this, the test above is inert.
      app.get('/api/__leak', async () => ({}));
    });
    const leak = routes.find((r) => r.url === '/api/__leak');
    expect(leak, 'the throwaway leak route should have been collected').toBeDefined();
    expect(isPublic(leak!)).toBe(false);
    expect(isGuarded(leak!)).toBe(false);
    // ...and it must surface in the same "unclassified" partition the AC#2 test asserts is empty.
    const unclassified = routes.filter((r) => !isPublic(r) && !isGuarded(r));
    expect(unclassified.map((r) => r.url)).toContain('/api/__leak');
  });

  // AC#3: dynamic reinforcement — an over-broad guard on a public route would 401 an anonymous
  // request. Only the two cheap bodyless GETs are checked dynamically (per AC#3's floor); the other
  // allowlisted routes need a request body / a configured OIDC provider, so their public reachability
  // rests on the structural partition above rather than a dynamic probe (see spec finding F2).
  it('public GET routes stay reachable unauthenticated (not 401) (AC#3)', async () => {
    const h = await buildRouteApp({ register: registerRoutes });
    try {
      for (const url of ['/api/health', '/api/auth/providers']) {
        const res = await h.app.inject({ method: 'GET', url });
        expect(res.statusCode, `${url} must not require auth`).not.toBe(401);
      }
    } finally {
      await h.app.close();
    }
  });
});
