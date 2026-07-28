import { describe, it, expect, afterEach, vi } from 'vitest';
import { buildNarratorrClients, buildNarratorrConnection } from './narratorr-clients.js';
import { NarratorrClient, NarratorrError } from './narratorr-client.js';
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

// The production boot graph. `src/server/index.ts` runs `main()` on import and can never be
// executed by a test, so these two wiring invariants live in this seam instead of in unreachable
// composition-root code — a route harness that merely MIRRORS the wiring is not evidence for it.
describe('buildNarratorrConnection', () => {
  it('installs both factory halves in the holder from one config, at generation zero', async () => {
    const seen = captureFetch();
    const { narratorr } = buildNarratorrConnection({ url: 'http://boot-n:3000', apiKey: 'boot-key' });

    expect(narratorr.configured).toBe(true);
    expect(narratorr.generation).toBe(0);

    await narratorr.getBook('bk_1').catch(() => {});
    await narratorr.openCompanionEpub('bk_1').catch(() => {});
    expect(seen).toHaveLength(2);
    expect(seen[0]?.url).toBe('http://boot-n:3000/api/v1/books/bk_1');
    expect(seen[1]?.url).toBe('http://boot-n:3000/api/v1/books/bk_1/companion-epub');
    expect(seen[0]?.apiKey).toBe('boot-key');
    expect(seen[1]?.apiKey).toBe('boot-key');
  });

  it('leaves the connection unconfigured when there is no saved config', async () => {
    const { narratorr } = buildNarratorrConnection(null);
    expect(narratorr.configured).toBe(false);
    // The boot WARN and the health route both read `configured`; every call must reach the shared
    // NOT_CONFIGURED contract rather than crashing on a missing client.
    await expect(Promise.resolve().then(() => narratorr.openCompanionEpub('bk_1'))).rejects.toBeInstanceOf(
      NarratorrError,
    );
  });

  it('keys FeatureService to THAT holder — for the probe AND the generation', async () => {
    // Two distinct defects this catches: a resolver probing a different client (it would never
    // see the live reconnect) and one keyed to a different generation (a swap would not retire
    // the previous server's cached capability).
    let capabilityCalls = 0;
    vi.stubGlobal('fetch', () => {
      capabilityCalls += 1;
      return Promise.resolve(
        new Response(JSON.stringify({ companionEpub: { enabled: true } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });
    const { narratorr, features } = buildNarratorrConnection({ url: 'http://boot-n:3000', apiKey: 'boot-key' });

    const T0 = 1_700_000_000_000;
    await expect(features.ebooksCapability(T0)).resolves.toBe(true);
    expect(capabilityCalls).toBe(1); // the probe went through THIS holder's client
    await expect(features.ebooksCapability(T0 + 1)).resolves.toBe(true);
    expect(capabilityCalls).toBe(1); // …and cached, so the re-probe below means something

    // Swapping the holder retires the entry — only true if the resolver reads THIS holder's
    // generation. A resolver keyed elsewhere would serve the cached value here.
    narratorr.set(buildNarratorrClients({ baseUrl: 'http://other-n:3000', apiKey: 'other-key' }));
    await expect(features.ebooksCapability(T0 + 2)).resolves.toBe(true);
    expect(capabilityCalls).toBe(2);
  });
});
