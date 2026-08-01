import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { registerNotFoundHandler } from './not-found.js';

/**
 * The client-serving tail of the HTTP surface: the built SPA (when one is present) plus the 404
 * handler that falls back to it.
 *
 * Extracted from `src/server/index.ts` for the same reason `buildNarratorrConnection` was —
 * `main()` runs on import, so nothing in that file is reachable from a test, and a wiring line
 * living there is a line no receipt can protect. As ONE named seam it is testable end to end:
 * `client-surface.route.test.ts` boots a real Fastify through this function and asserts both
 * outcomes, so deleting either registration (the SPA static mount or the not-found handler) turns
 * a suite red instead of silently shipping Fastify's default 404 or a 500 on every SPA deep link.
 *
 * Ordering note, measured rather than assumed: `@fastify/static` is `fastify-plugin`-wrapped, so
 * `reply.sendFile` lands on the root instance and the SPA fallback works with the not-found
 * handler registered on either side of it. The static mount is kept first anyway because that is
 * the order a reader expects, but no test asserts an ordering the framework does not enforce.
 */
export async function registerClientSurface(
  app: FastifyInstance,
  opts: { serveClient: boolean; clientDir: string },
): Promise<void> {
  if (opts.serveClient) {
    await app.register(fastifyStatic, { root: opts.clientDir, wildcard: false });
  }
  registerNotFoundHandler(app, { serveClient: opts.serveClient });
}
