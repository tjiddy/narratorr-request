import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { buildRouteApp, type RouteHarness } from '../test-support/route-harness.js';
import { ApiError, badRequest } from '../util/errors.js';
import { NarratorrError } from '../services/narratorr-client.js';

// The 5xx scrub in error-handler.ts is a SECURITY control: a server-to-server failure
// (or an unhandled throw) must never leak its internal/upstream detail to the browser.
// These tests drive the plugin through throwaway routes that throw each error shape and
// assert both the public wording AND that the raw message string is absent from the body.

const SCRUB = 'A required service is temporarily unavailable. Please try again.';
const RAW_UPSTREAM = 'Narratorr GET /books timed out';

let h: RouteHarness;
beforeEach(async () => {
  h = await buildRouteApp({
    register: (app: FastifyInstance) => {
      const a = app.withTypeProvider<ZodTypeProvider>();
      a.get('/boom/not-configured', async () => {
        throw new NarratorrError(0, 'NOT_CONFIGURED', "Narratorr isn't connected yet. Set it up in Settings.");
      });
      a.get('/boom/network', async () => {
        throw new NarratorrError(0, 'NETWORK', RAW_UPSTREAM);
      });
      a.get('/boom/timeout', async () => {
        // #213 split the status-0 class; only NOT_CONFIGURED is special-cased here, so the new
        // code must take the same generic scrub path as NETWORK.
        throw new NarratorrError(0, 'TIMEOUT', RAW_UPSTREAM);
      });
      a.get('/boom/service-unavailable', async () => {
        // A 503-status ApiError must STAY 503 through the scrub path (not collapse to 502).
        throw new ApiError(503, 'DEP_DOWN', 'raw 503 detail that must not leak');
      });
      a.get('/boom/bad-request', async () => {
        throw badRequest('SOME_CODE', 'a perfectly user-facing 4xx message');
      });
      a.get(
        '/boom/validate',
        { schema: { querystring: z.object({ n: z.string().min(3) }) } },
        async () => ({ ok: true }),
      );
      a.get('/boom/throttled', async () => {
        // A plain (non-ApiError) error carrying statusCode 429 — the belt-and-braces branch.
        const err = new Error('internal throttle detail') as Error & { statusCode?: number };
        err.statusCode = 429;
        throw err;
      });
      a.get('/boom/unhandled', async () => {
        throw new Error('something bad');
      });
    },
  });
});
afterEach(async () => {
  await h.app.close();
  vi.restoreAllMocks();
});

const get = (url: string) => h.app.inject({ method: 'GET', url });

describe('error-handler — 5xx scrub (security) + status/code mapping', () => {
  it('NarratorrError NOT_CONFIGURED → 503 with the user-facing message preserved (NOT scrubbed)', async () => {
    const res = await get('/boom/not-configured');
    expect(res.statusCode).toBe(503);
    const { error } = res.json();
    expect(error.code).toBe('NOT_CONFIGURED');
    expect(error.message).toContain('Settings');
    expect(error.message).not.toBe(SCRUB);
  });

  it.each(['/boom/network', '/boom/timeout'])(
    'generic 5xx NarratorrError (%s) → 502, code preserved, message scrubbed, raw upstream detail absent',
    async (url) => {
      const res = await get(url);
      expect(res.statusCode).toBe(502);
      const { error } = res.json();
      expect(error.code).toBe('NARRATORR_UPSTREAM');
      expect(error.message).toBe(SCRUB);
      // The security property under test: the raw upstream string never reaches the browser.
      expect(res.body).not.toContain(RAW_UPSTREAM);
    },
  );

  it('a 503-status ApiError stays 503 (not collapsed to 502) and is scrubbed', async () => {
    const res = await get('/boom/service-unavailable');
    expect(res.statusCode).toBe(503);
    const { error } = res.json();
    expect(error.code).toBe('DEP_DOWN');
    expect(error.message).toBe(SCRUB);
    expect(res.body).not.toContain('raw 503 detail');
  });

  it('4xx ApiError → status/code/message passed through unscrubbed', async () => {
    const res = await get('/boom/bad-request');
    expect(res.statusCode).toBe(400);
    const { error } = res.json();
    expect(error.code).toBe('SOME_CODE');
    expect(error.message).toBe('a perfectly user-facing 4xx message');
  });

  it('Zod/Fastify validation failure → 400 BAD_REQUEST', async () => {
    const res = await get('/boom/validate?n=a');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BAD_REQUEST');
  });

  it('a plain 429 → 429 RATE_LIMITED (not masqueraded as 500), raw detail absent', async () => {
    const res = await get('/boom/throttled');
    expect(res.statusCode).toBe(429);
    const { error } = res.json();
    expect(error.code).toBe('RATE_LIMITED');
    expect(res.body).not.toContain('internal throttle detail');
  });

  it('a non-ApiError throw → 500 INTERNAL with the generic message, raw detail absent', async () => {
    const res = await get('/boom/unhandled');
    expect(res.statusCode).toBe(500);
    const { error } = res.json();
    expect(error.code).toBe('INTERNAL');
    expect(error.message).toBe('Internal server error');
    expect(res.body).not.toContain('something bad');
  });
});
