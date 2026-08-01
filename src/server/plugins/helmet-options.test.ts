import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import { buildHelmetOptions } from './helmet-options.js';

// helmet is registered inline in `main()`, which auto-runs on import (migrations + port bind +
// poller) and is therefore not `inject()`-able, so there's no seam to assert the headers against
// in the real app. These tests exercise the extracted factory directly: a bare Fastify instance
// per branch, register the factory output, hit a route, inspect the emitted headers.
async function buildApp(behindTls: boolean): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(helmet, buildHelmetOptions({ behindTls }));
  app.get('/', async () => ({ ok: true }));
  await app.ready();
  return app;
}

let toClose: FastifyInstance | undefined;
afterEach(async () => {
  await toClose?.close();
  toClose = undefined;
});

// The full CSP helmet emits today, as a golden string — INCLUDING the default-merged
// `form-action 'self'`, `script-src-attr 'none'`, and `upgrade-insecure-requests` in helmet's
// exact emission order (since @fastify/helmet 13.1: `default-src` first, the rest alphabetical).
// Pinned so any future helmet merge drift (reorder / new default) fails loudly instead of
// silently changing the security posture of the prod-behind-TLS deploy.
const CSP_BEHIND_TLS =
  "default-src 'self';base-uri 'self';font-src 'self' https://fonts.gstatic.com;" +
  "form-action 'self';frame-ancestors 'none';img-src 'self' https: data:;object-src 'none';" +
  "script-src 'self';script-src-attr 'none';" +
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;" +
  'upgrade-insecure-requests';

describe('buildHelmetOptions — behindTls header emission', () => {
  it('behindTls=true → full hardened CSP (byte-identical to today) + HSTS', async () => {
    const app = await buildApp(true);
    toClose = app;
    const res = await app.inject({ method: 'GET', url: '/' });

    expect(res.headers['content-security-policy']).toBe(CSP_BEHIND_TLS);
    expect(res.headers['strict-transport-security']).toBeDefined();
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('behindTls=false → no upgrade-insecure-requests, no HSTS; every other directive unchanged', async () => {
    const app = await buildApp(false);
    toClose = app;
    const res = await app.inject({ method: 'GET', url: '/' });

    const csp = res.headers['content-security-policy'];
    expect(csp).toBeDefined();
    // The TLS-assuming directive/header are gone — this is what unblocks the plain-HTTP page.
    expect(csp).not.toContain('upgrade-insecure-requests');
    expect(res.headers['strict-transport-security']).toBeUndefined();

    // Everything else is exactly the true-branch CSP minus the trailing `;upgrade-insecure-requests`.
    expect(csp).toBe(CSP_BEHIND_TLS.replace(';upgrade-insecure-requests', ''));
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });
});
