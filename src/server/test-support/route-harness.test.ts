import { describe, it, expect } from 'vitest';
import { buildRouteApp } from './route-harness.js';
import { registerHealthRoutes } from '../routes/health.js';

// The harness's narratorr wiring is shared by every route-test file, so the "configured" and
// "unconfigured" states it hands out are asserted here once rather than re-derived per suite.
// Since #145 a connection is a PAIR (JSON + raw stream) installed together, so `narratorrConfigured`
// must arm or disarm BOTH halves — a harness that only wired the JSON half would let a future
// proxy-route test see a working stream against an unconfigured narratorr.

const NOT_CONFIGURED = { statusCode: 502, upstreamCode: 'NOT_CONFIGURED' };
// `require()` throws synchronously; every real caller observes it as a rejection because it awaits.
const awaited = (fn: () => unknown) => Promise.resolve().then(fn);

describe('route harness — narratorr connection wiring', () => {
  it('arms both halves when configured: JSON and the companion stream reach their fakes', async () => {
    const h = await buildRouteApp({ register: registerHealthRoutes });
    try {
      expect(h.narratorrHolder.configured).toBe(true);
      await expect(h.narratorrHolder.getBook('bk_1')).resolves.toMatchObject({ id: 'bk_1' });

      const stream = await h.narratorrHolder.openCompanionEpub('bk_1');
      expect(h.ebookStream.opened).toEqual(['bk_1']);
      expect(stream.contentType).toBe('application/epub+zip');
      expect(stream.contentLength).toBe(h.ebookStream.bytes.byteLength);
    } finally {
      await h.app.close();
    }
  });

  it('disarms both halves with narratorrConfigured: false', async () => {
    const h = await buildRouteApp({ register: registerHealthRoutes, narratorrConfigured: false });
    try {
      expect(h.narratorrHolder.configured).toBe(false);
      await expect(awaited(() => h.narratorrHolder.searchMetadata('q'))).rejects.toMatchObject(NOT_CONFIGURED);
      await expect(awaited(() => h.narratorrHolder.getCapabilities())).rejects.toMatchObject(NOT_CONFIGURED);
      await expect(awaited(() => h.narratorrHolder.openCompanionEpub('bk_1'))).rejects.toMatchObject(NOT_CONFIGURED);
      expect(h.ebookStream.opened).toEqual([]);
    } finally {
      await h.app.close();
    }
  });
});
