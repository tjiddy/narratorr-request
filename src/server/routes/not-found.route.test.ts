import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { describe, it, expect, afterEach } from 'vitest';
import { registerNotFoundHandler } from './not-found.js';

// The 404 registrar extracted from `src/server/index.ts` (issue #146 AC35). Both production and
// the route-test harness call it, so the two cannot drift — but that only helps if the extraction
// is byte-identical to what production used to do, SPA-fallback branch included. That is what this
// file pins; the harness-side consequence (router misses answering OUR envelope) is asserted in
// `ebooks.route.test.ts`.

const INDEX_HTML = '<!doctype html><title>spa</title>';

let app: FastifyInstance | null = null;
let dir: string | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

/** A bare Fastify with the registrar installed — deliberately NOT the route harness. */
async function build(serveClient: boolean): Promise<FastifyInstance> {
  app = Fastify();
  if (serveClient) {
    dir = mkdtempSync(path.join(tmpdir(), 'nreq-notfound-'));
    writeFileSync(path.join(dir, 'index.html'), INDEX_HTML);
    await app.register(fastifyStatic, { root: dir, wildcard: false });
  }
  registerNotFoundHandler(app, { serveClient });
  await app.ready();
  return app;
}

describe('registerNotFoundHandler — API-only branch (serveClient: false)', () => {
  it('answers our NOT_FOUND envelope, interpolating only the callers own method and url', async () => {
    const a = await build(false);
    const res = await a.inject({ method: 'GET', url: '/api/nope?x=1' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'Route GET /api/nope?x=1 not found' },
    });
  });

  it('answers the same envelope for a non-API GET (there is no SPA to fall back to)', async () => {
    const a = await build(false);
    expect((await a.inject({ method: 'GET', url: '/anything' })).json().error.code).toBe('NOT_FOUND');
  });
});

describe('registerNotFoundHandler — SPA branch (serveClient: true)', () => {
  it('still serves index.html for a non-API GET, so client-side routing keeps working', async () => {
    const a = await build(true);
    const res = await a.inject({ method: 'GET', url: '/requests/42' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(INDEX_HTML);
  });

  it('keeps the JSON envelope for anything under /api/ — the SPA fallback must not swallow it', async () => {
    const a = await build(true);
    const res = await a.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('keeps the JSON envelope for a non-GET, even outside /api/', async () => {
    const a = await build(true);
    const res = await a.inject({ method: 'POST', url: '/requests/42' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'Route POST /requests/42 not found' },
    });
  });
});
