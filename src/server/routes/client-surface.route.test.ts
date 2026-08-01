import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, it, expect, afterEach } from 'vitest';
import { registerClientSurface } from './client-surface.js';

// The production client-serving composition (issue #146 AC35), driven through the SAME function
// `src/server/index.ts` calls. `not-found.route.test.ts` covers the 404 handler in isolation and
// the route harness installs it independently — neither of those notices if the PRODUCTION path
// stops calling it. This file closes that gap: every case below boots a real Fastify through
// `registerClientSurface`, so deleting either registration inside the seam fails here.

const INDEX_HTML = '<!doctype html><title>spa</title>';
const SERVER_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let app: FastifyInstance | null = null;
let dir: string | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

/** Boot a bare Fastify through the production seam. A client dir always exists; `serveClient` decides. */
async function build(serveClient: boolean): Promise<FastifyInstance> {
  dir = mkdtempSync(path.join(tmpdir(), 'nreq-client-surface-'));
  writeFileSync(path.join(dir, 'index.html'), INDEX_HTML);
  app = Fastify();
  await registerClientSurface(app, { serveClient, clientDir: dir });
  await app.ready();
  return app;
}

describe('registerClientSurface — the SPA branch (serveClient: true)', () => {
  it('mounts the static root: a deep link falls back to index.html', async () => {
    // Deletion-sensitive in BOTH directions. Drop the `@fastify/static` registration and
    // `reply.sendFile` is undefined, so this 500s; drop `registerNotFoundHandler` and Fastify's
    // default 404 answers instead of the SPA.
    const a = await build(true);
    const res = await a.inject({ method: 'GET', url: '/requests/42' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(INDEX_HTML);
  });

  it('serves a real asset from the static root', async () => {
    const a = await build(true);
    const res = await a.inject({ method: 'GET', url: '/index.html' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(INDEX_HTML);
  });

  it('keeps the JSON envelope under /api/ — the SPA fallback must never swallow an API miss', async () => {
    const a = await build(true);
    const res = await a.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Route GET /api/nope not found' } });
  });

  it('keeps the JSON envelope for a non-GET outside /api/', async () => {
    const a = await build(true);
    const res = await a.inject({ method: 'POST', url: '/requests/42' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});

describe('registerClientSurface — the API-only branch (serveClient: false)', () => {
  it('installs our 404 handler, not Fastify default, for a non-API GET', async () => {
    const a = await build(false);
    const res = await a.inject({ method: 'GET', url: '/anything' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Route GET /anything not found' } });
  });

  it('does NOT mount the static root — a real asset is a miss, not a file', async () => {
    // The `serveClient` branch has to be genuinely conditional: mounting statics unconditionally
    // would serve whatever happens to sit in the directory on a dev/API-only boot.
    const a = await build(false);
    const res = await a.inject({ method: 'GET', url: '/index.html' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('answers the API envelope for an /api/ miss', async () => {
    const a = await build(false);
    const res = await a.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});

describe('production composition (the one line no runtime test can reach)', () => {
  // `src/server/index.ts` calls `main()` on import, so it cannot be executed by a test — the same
  // constraint that made `buildNarratorrConnection` a seam. What IS checkable is that the file
  // routes through the extracted seam rather than hand-rolling the composition again, which is the
  // failure mode the extraction exists to prevent.
  const source = readFileSync(path.join(SERVER_DIR, 'index.ts'), 'utf8');

  it('boots the client surface through the shared seam', () => {
    expect(source).toMatch(/registerClientSurface\(app, \{\s*serveClient,\s*clientDir\s*\}\)/);
  });

  it('does not re-inline the composition the seam owns', () => {
    // Either of these reappearing in `index.ts` means production drifted back to its own copy,
    // and every receipt in this file would stop describing what actually ships.
    expect(source).not.toMatch(/setNotFoundHandler/);
    expect(source).not.toMatch(/fastifyStatic/);
  });
});
