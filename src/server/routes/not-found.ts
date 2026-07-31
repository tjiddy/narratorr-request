import type { FastifyInstance } from 'fastify';
import { errorBody } from '../../shared/schemas/v1/common.js';

/**
 * The app's 404 handler — extracted from `src/server/index.ts` (issue #146 AC35) so route tests
 * can install PRODUCTION's behavior instead of asserting Fastify's default body, which no client
 * ever receives.
 *
 * It is load-bearing for the download proxy: some URL shapes (e.g. an unencoded `/` inside the
 * `:bookId` segment) are refused by find-my-way BEFORE any route hook runs, so they never reach
 * the handler's guard or its id grammar. What they must still be is CONTENT-FREE — our envelope,
 * with a message interpolating only the caller's own URL, and no upstream call. Sharing one
 * registrar is what keeps the harness and production from drifting on that. (A segment past
 * `maxParamLength` is refused even earlier since fastify 5.11 — a 414 `FST_ERR_MAX_PARAM_LENGTH`
 * emitted before routing, bypassing this handler entirely, like `FST_ERR_BAD_URL`.)
 *
 * `serveClient` mirrors the boot-time decision: when the built SPA is present a non-API GET falls
 * back to `index.html` (client-side routing), while anything under `/api/` — and every non-GET —
 * still gets the JSON envelope. `@fastify/static` must already be registered on that branch.
 */
export function registerNotFoundHandler(app: FastifyInstance, opts: { serveClient: boolean }): void {
  const envelope = (method: string, url: string) => errorBody('NOT_FOUND', `Route ${method} ${url} not found`);

  if (opts.serveClient) {
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/')) {
        return reply.sendFile('index.html');
      }
      return reply.status(404).send(envelope(request.method, request.url));
    });
    return;
  }

  app.setNotFoundHandler((request, reply) => reply.status(404).send(envelope(request.method, request.url)));
}
