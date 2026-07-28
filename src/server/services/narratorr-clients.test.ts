import { describe, it, expect, afterEach, vi } from 'vitest';
import { buildNarratorrClients } from './narratorr-clients.js';
import { NarratorrClient } from './narratorr-client.js';
import { NarratorrStreamClient } from './narratorr-stream-client.js';

// Issue #145 AC15: ONE config read must feed BOTH halves of a connection. The credentials are
// private to each client, so the assertion is behavioral — stub `fetch` and read back the URL
// and api key each half actually puts on the wire. No socket is opened.

afterEach(() => {
  vi.unstubAllGlobals();
});

interface Wire {
  url: string;
  apiKey: string | null;
}

/** Capture what each client sends, answering everything with a 500 the callers then swallow. */
function captureFetch(): Wire[] {
  const seen: Wire[] = [];
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen.push({ url: String(input), apiKey: headers.get('x-api-key') });
    return Promise.resolve(new Response(null, { status: 500 }));
  });
  return seen;
}

describe('buildNarratorrClients', () => {
  it('builds a JSON + stream pair', () => {
    const pair = buildNarratorrClients({ baseUrl: 'http://n.example:3000', apiKey: 'k' });
    expect(pair.json).toBeInstanceOf(NarratorrClient);
    expect(pair.stream).toBeInstanceOf(NarratorrStreamClient);
  });

  it('gives both halves the SAME base URL and api key from one config', async () => {
    const seen = captureFetch();
    const pair = buildNarratorrClients({ baseUrl: 'http://n.example:3000/', apiKey: 'shared-key' });

    await pair.json.getBook('bk_1').catch(() => {});
    await pair.stream.openCompanionEpub('bk_1').catch(() => {});

    expect(seen).toHaveLength(2);
    expect(seen[0]?.apiKey).toBe('shared-key');
    expect(seen[1]?.apiKey).toBe('shared-key');
    expect(seen[0]?.url).toBe('http://n.example:3000/api/v1/books/bk_1');
    expect(seen[1]?.url).toBe('http://n.example:3000/api/v1/books/bk_1/companion-epub');
    // The credential pair is what must not diverge — a second config read between the two
    // constructions is exactly the defect this pins.
    expect(new Set(seen.map((s) => s.apiKey)).size).toBe(1);
    expect(new Set(seen.map((s) => new URL(s.url).origin)).size).toBe(1);
  });
});
