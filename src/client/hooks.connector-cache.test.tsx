import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ConnectorSettingsDto } from '@shared/schemas/connectors';
import { qk, useConnectorSettings, useUpdateConnectors, useUpdateEbooksEnabled } from './hooks';

/**
 * Concurrent-save CONVERGENCE for the shared `qk.connectors` entry (#144 / learning #160).
 *
 * The hook-level tests in `hooks.test.ts` mock `@tanstack/react-query`, so they can only assert
 * which cache OPERATIONS a mutation requests — never what the cache ends up holding. That is
 * exactly the gap this file closes: the defect being guarded against is a lost update whose
 * symptom only exists in the FINAL cache value after two responses settle in the wrong order. So
 * this file runs the real QueryClient, the real hooks, and a fake server with an authoritative
 * row, drives the settle order by hand, and asserts the value the cache converges on.
 *
 * The race: the Settings page instantiates several independent saves against one cache entry
 * (Public URL, default quota, Narratorr, and now the ebook toggle). The server computes each PUT
 * response from the row as it stood when THAT request read it. A response that settles LAST
 * therefore carries a snapshot that may predate a sibling's committed write — so a mutation that
 * writes its response wholesale silently rolls the sibling's field back in the UI while the DB
 * holds the opposite. Converging requires that no save blind-writes the shared entry.
 *
 * Scope note: this file covers convergence when the writes SUCCEED. The other half — a write that
 * commits and then answers 500 from the reconfiguration tail — lives in
 * `hooks.settings-error-path.test.tsx`. Both belong at this layer for the same reason.
 */

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const CONNECTORS_URL = '/api/admin/settings/connectors';

const baseRow = (): ConnectorSettingsDto => ({
  publicUrl: null,
  narratorr: null,
  notifiers: [],
  defaultQuota: { mode: 'limited', limit: 10, windowDays: 30 },
  requesterEmailWarning: false,
  kindleSender: null,
  ebooksEnabled: false,
});

const jsonRes = (payload: unknown): Response =>
  ({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(payload)) }) as unknown as Response;

/**
 * A fake connectors endpoint over one authoritative `row`.
 *
 * A PUT commits its body to `row` immediately (as the DB write does) but resolves its RESPONSE
 * through a deferred the test releases — and the response body is snapshotted at commit time, so
 * holding one models precisely the real hazard: a response computed before a sibling's write,
 * delivered after it.
 */
function fakeServer() {
  const row = baseRow();
  const pending: Array<() => void> = [];

  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith(CONNECTORS_URL)) throw new Error(`unstubbed fetch: ${url}`);
    if (init?.method !== 'PUT') return Promise.resolve(jsonRes({ ...row }));

    Object.assign(row, JSON.parse(String(init.body)) as Partial<ConnectorSettingsDto>);
    const snapshot = { ...row }; // what the server would serialize for THIS request, now
    return new Promise<Response>((resolve) => pending.push(() => resolve(jsonRes(snapshot))));
  });
  vi.stubGlobal('fetch', fetchMock);

  return {
    row,
    /** Release the Nth still-held PUT response (0 = the earliest outstanding). */
    release: (index: number) => pending.splice(index, 1)[0]?.(),
    heldCount: () => pending.length,
  };
}

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

/**
 * Mount the reader and both saves in ONE component, the way the Settings page does. They must
 * share a render root, not just a QueryClient: separate roots each re-render independently, so a
 * cache correction that reaches one is not observable through the others' snapshots.
 */
function mountSettings(client: QueryClient) {
  return renderHook(
    () => ({
      read: useConnectorSettings(),
      sibling: useUpdateConnectors(),
      toggle: useUpdateEbooksEnabled(),
    }),
    { wrapper: wrapper(client) },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('qk.connectors convergence under concurrent saves (#144, learning #160)', () => {
  it('converges on BOTH committed fields when the sibling response settles LAST', async () => {
    const server = fakeServer();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    // An active observer, so an invalidation actually schedules a refetch (an unobserved query is
    // only marked stale). This is the real page's shape — the Settings form reads this query.
    const { result } = mountSettings(client);
    await waitFor(() => expect(result.current.read.isSuccess).toBe(true));

    // 1. The Public URL save commits first and its response is HELD — the snapshot it will
    //    eventually deliver still carries `ebooksEnabled: false`.
    result.current.sibling.mutate({ publicUrl: 'https://app.example.com' });
    await waitFor(() => expect(server.heldCount()).toBe(1));

    // 2. The toggle save commits second and settles FIRST.
    result.current.toggle.mutate({ ebooksEnabled: true });
    await waitFor(() => expect(server.heldCount()).toBe(2));
    server.release(1);
    await waitFor(() => expect(result.current.toggle.isSuccess).toBe(true));

    // Both writes are durable server-side at this point.
    expect(server.row).toMatchObject({ publicUrl: 'https://app.example.com', ebooksEnabled: true });

    // 3. Now the stale sibling response arrives.
    server.release(0);
    await waitFor(() => expect(result.current.sibling.isSuccess).toBe(true));

    // The cache must reflect the authoritative row, not the stale snapshot. A `setQueryData` on
    // either mutation loses this: the last writer wins and the toggle reverts to `false` on screen
    // with nothing left in flight to repair it.
    await waitFor(() => {
      expect(client.getQueryData<ConnectorSettingsDto>(qk.connectors)).toMatchObject({
        publicUrl: 'https://app.example.com',
        ebooksEnabled: true,
      });
    });
    // …and the value the mounted reader RENDERS agrees (not merely the raw cache entry) — the
    // observer has to see the corrected data for the Settings form to reseed from it.
    await waitFor(() => {
      expect(result.current.read.data).toMatchObject({ publicUrl: 'https://app.example.com', ebooksEnabled: true });
    });
  });

  it('converges in the mirror order too — toggle response last', async () => {
    // The symmetric case: whichever response settles last must not be able to win, so neither
    // mutation may blind-write. Without this row a fix that only hardened one of the two passes.
    const server = fakeServer();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = mountSettings(client);
    await waitFor(() => expect(result.current.read.isSuccess).toBe(true));

    result.current.toggle.mutate({ ebooksEnabled: true });
    await waitFor(() => expect(server.heldCount()).toBe(1));
    result.current.sibling.mutate({ publicUrl: 'https://app.example.com' });
    await waitFor(() => expect(server.heldCount()).toBe(2));

    server.release(1); // the publicUrl response settles first
    await waitFor(() => expect(result.current.sibling.isSuccess).toBe(true));
    server.release(0); // …the toggle's (now stale on publicUrl) settles last
    await waitFor(() => expect(result.current.toggle.isSuccess).toBe(true));

    await waitFor(() => {
      expect(client.getQueryData<ConnectorSettingsDto>(qk.connectors)).toMatchObject({
        publicUrl: 'https://app.example.com',
        ebooksEnabled: true,
      });
    });
  });

  it('ends with a REFETCH, not a blind write — the settled cache matches a fresh GET', async () => {
    // Pins the mechanism rather than just the outcome: after everything settles, the cache holds
    // exactly what the server would serve now. A lucky-ordering blind write could match the
    // expected fields above by coincidence; it cannot match a fresh read of the whole row.
    const server = fakeServer();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = mountSettings(client);
    await waitFor(() => expect(result.current.read.isSuccess).toBe(true));

    result.current.sibling.mutate({ defaultQuota: { mode: 'unlimited', windowDays: 7 } });
    await waitFor(() => expect(server.heldCount()).toBe(1));
    result.current.toggle.mutate({ ebooksEnabled: true });
    await waitFor(() => expect(server.heldCount()).toBe(2));
    server.release(1);
    await waitFor(() => expect(result.current.toggle.isSuccess).toBe(true));
    server.release(0);
    await waitFor(() => expect(result.current.sibling.isSuccess).toBe(true));

    await waitFor(() => {
      expect(client.getQueryData<ConnectorSettingsDto>(qk.connectors)).toEqual({ ...server.row });
    });
  });
});
