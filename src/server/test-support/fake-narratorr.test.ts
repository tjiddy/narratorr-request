import { describe, it, expect, afterEach } from 'vitest';
import { startFakeNarratorr, type FakeNarratorr } from './fake-narratorr.js';

// The fake's REFUSAL contract, pinned directly. Both branches exist to stop the integration suite
// certifying a client regression: an anonymous caller and a caller using the wrong verb must be
// turned away before any endpoint handler runs. The scenarios only ever send well-formed requests,
// so without this file either branch could be deleted with the whole suite still green — the same
// gap the DATA-rejection and partial-startup receipts close for the other test-support pieces.

const API_KEY = 'sk-fake-narratorr-contract';

let fake: FakeNarratorr | null = null;

afterEach(async () => {
  await fake?.close();
  fake = null;
});

describe('the fake narratorr refuses before it serves', () => {
  it('answers 401 for a wrong key, echoes NEITHER key, and never reaches the handler', async () => {
    fake = await startFakeNarratorr({ apiKey: API_KEY });
    fake.companionEpub = { kind: 'body', bytes: new Uint8Array([1, 2, 3]) };

    const res = await fetch(`${fake.baseUrl}/api/v1/books/bk_1/companion-epub`, {
      headers: { 'x-api-key': 'the-wrong-key' },
    });
    const body = await res.text();

    expect(res.status).toBe(401);
    // The refusal is an oracle for nothing: neither the presented nor the configured key appears.
    expect(body).not.toContain('the-wrong-key');
    expect(body).not.toContain(API_KEY);
    // "Never reaches the endpoint handler" — the companion counter is what proves it, since a
    // handler that ran would have incremented it before writing anything.
    expect(fake.companionOpens).toBe(0);
    expect(fake.receipts).toEqual([
      { method: 'GET', path: '/api/v1/books/bk_1/companion-epub', keyMatched: false },
    ]);
  }, 30_000);

  it('answers 405 for a non-GET even WITH the right key, and records the method', async () => {
    fake = await startFakeNarratorr({ apiKey: API_KEY });

    const res = await fetch(`${fake.baseUrl}/api/v1/capabilities`, {
      method: 'POST',
      headers: { 'x-api-key': API_KEY },
    });

    expect(res.status).toBe(405);
    expect(fake.receipts).toEqual([{ method: 'POST', path: '/api/v1/capabilities', keyMatched: true }]);
  }, 30_000);

  it('serves the same endpoint normally once the request is a GET with the right key', async () => {
    // The control for both refusals: the endpoint is genuinely reachable, so the two rejections
    // above are the gates doing their job rather than a fake that answers nothing.
    fake = await startFakeNarratorr({ apiKey: API_KEY });

    const res = await fetch(`${fake.baseUrl}/api/v1/capabilities`, { headers: { 'x-api-key': API_KEY } });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ companionEpub: { enabled: true } });
    expect(fake.receipts).toEqual([{ method: 'GET', path: '/api/v1/capabilities', keyMatched: true }]);
  }, 30_000);
});
