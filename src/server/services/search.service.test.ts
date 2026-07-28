import { describe, it, expect } from 'vitest';
import { SearchService } from './search.service.js';
import type { IMetadataSearchClient } from './narratorr-client.js';
import type { V1AudibleResult } from '../../shared/schemas/v1/metadata.js';

function fakeClient() {
  let calls = 0;
  const client: IMetadataSearchClient = {
    async searchMetadata(q: string): Promise<V1AudibleResult[]> {
      calls += 1;
      return [{ asin: 'A', title: q, authors: [], narrators: [], cover: null }];
    },
  };
  return { client, calls: () => calls };
}

describe('SearchService', () => {
  it('serves repeat queries from cache without re-hitting upstream', async () => {
    const { client, calls } = fakeClient();
    const svc = new SearchService(client, { cacheTtlMs: 1000 });
    await svc.search(1, 'dune', 0);
    await svc.search(1, 'Dune', 100); // case/space-insensitive key
    await svc.search(2, '  dune ', 200);
    expect(calls()).toBe(1);
  });

  it('refetches after the cache TTL lapses', async () => {
    const { client, calls } = fakeClient();
    const svc = new SearchService(client, { cacheTtlMs: 1000 });
    await svc.search(1, 'dune', 0);
    await svc.search(1, 'dune', 2000);
    expect(calls()).toBe(2);
  });

  it('throttles a user past the per-window cap (cache misses only)', async () => {
    const { client } = fakeClient();
    const svc = new SearchService(client, { cacheTtlMs: 0, ratePerWindow: 2, windowMs: 1000 });
    await svc.search(1, 'a', 0);
    await svc.search(1, 'b', 10);
    await expect(svc.search(1, 'c', 20)).rejects.toMatchObject({ code: 'SEARCH_THROTTLED' });
  });

  it('does not consume a throttle token on a cache hit', async () => {
    const { client } = fakeClient();
    const svc = new SearchService(client, { cacheTtlMs: 10_000, ratePerWindow: 1, windowMs: 1000 });
    await svc.search(1, 'a', 0); // consumes the only token, caches "a"
    await svc.search(1, 'a', 10); // cache hit — no token
    await expect(svc.search(1, 'a', 20)).resolves.toBeTruthy(); // still cached
  });

  it('resets the window after it elapses', async () => {
    const { client } = fakeClient();
    const svc = new SearchService(client, { cacheTtlMs: 0, ratePerWindow: 1, windowMs: 1000 });
    await svc.search(1, 'a', 0);
    await expect(svc.search(1, 'b', 500)).rejects.toMatchObject({ code: 'SEARCH_THROTTLED' });
    await expect(svc.search(1, 'c', 1500)).resolves.toBeTruthy();
  });
});
