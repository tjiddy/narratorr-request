import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { MeDto, UserDto } from '@shared/schemas/user';
import type { RequestDto, RequestStatus } from '@shared/schemas/request';
import { OPEN_REQUEST_STATUSES } from '@shared/schemas/request';
import type { V1AudibleResult } from '@shared/schemas/v1/metadata';
import {
  qk,
  useMe,
  useMyRequests,
  useAdminQueue,
  useUsers,
  useRequestBook,
  useDecide,
  useUpdateUser,
  useUpdateMe,
  useLocalAuth,
} from './hooks';

/**
 * COMMIT-THEN-ERROR reconciliation for the request/user/account mutations, proven at the API
 * boundary against a real QueryClient (#168).
 *
 * The sibling `hooks.settings-error-path.test.tsx` makes the same argument for the settings family;
 * this file covers the five hooks that were left un-converted. Each of these routes can answer
 * non-2xx over a write that is already durable:
 *   • `POST /api/requests` inserts, then runs a fallible auto-approve `handoff()`;
 *   • `POST /api/admin/requests/:id/decision` atomically CLAIMS the status, then emails + hands off;
 *   • `PATCH /api/admin/users/:id` commits atomically — but the RESPONSE can still be lost;
 *   • `PATCH /api/me` applies three INDEPENDENT writes before a shared, fallible DTO tail;
 *   • `POST /api/auth/local/{signup,login}` sets the session cookie before the body is produced.
 *
 * `hooks.test.ts` mocks `@tanstack/react-query` wholesale, so it can only assert that the
 * invalidation was REQUESTED — no cache, no observer, no refetch (`react-query-mock-hides-cache-
 * convergence`). The consequence that matters is that MOUNTED OBSERVERS end up on the committed
 * state after a rejected mutation, so that claim lives here.
 *
 * Assertion discipline throughout (`react-query-observer-lags-cache-on-refetch-error`): the cache
 * and the mounted observer reach a refetch outcome at different times and only the observer drives
 * rendering, so the mutation's own terminal state is asserted as the PREMISE and every convergence
 * claim is `waitFor`-ed on the observer.
 */

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const jsonRes = (status: number, payload: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(payload)),
  }) as unknown as Response;

/** A body `parse()` cannot read — the lost/garbled response an already-committed write can answer. */
const unparseableRes = (status: number): Response =>
  ({ ok: status >= 200 && status < 300, status, text: () => Promise.resolve('<html>502 Bad Gateway') }) as unknown as Response;

const fail = (status: number, code: string, message: string) => jsonRes(status, { error: { code, message } });

const baseMe = (over: Partial<MeDto> = {}): MeDto => ({
  publicId: 'us_1',
  username: 'todd',
  authProvider: 'local',
  email: 'todd@example.com',
  thumb: null,
  role: 'user',
  status: 'active',
  requestQuota: { mode: 'inherit' },
  autoApprove: false,
  createdAt: '2026-07-01T00:00:00.000Z',
  quota: { mode: 'limited', limit: 10, used: 0, remaining: 10, windowDays: 30 },
  notifyOn: [],
  emailNotifyAvailable: false,
  kindleEmail: null,
  ...over,
});

const request = (over: Partial<RequestDto> = {}): RequestDto => ({
  publicId: 'rq_1',
  asin: 'B01',
  title: 'Dune',
  author: null,
  narrator: null,
  coverUrl: null,
  status: 'pending',
  note: null,
  failureReason: null,
  requestedAt: '2026-07-01T00:00:00.000Z',
  decidedAt: null,
  narratorrBookId: null,
  companionEbook: null,
  requester: { publicId: 'us_1', username: 'todd' },
  ...over,
});

const user = (over: Partial<UserDto> = {}): UserDto => ({
  publicId: 'us_2',
  username: 'ann',
  authProvider: 'local',
  email: 'ann@example.com',
  thumb: null,
  role: 'user',
  status: 'active',
  requestQuota: { mode: 'inherit' },
  autoApprove: false,
  createdAt: '2026-07-01T00:00:00.000Z',
  ...over,
});

const searchResult: V1AudibleResult = { asin: 'B02', title: 'Neuromancer', authors: [], narrators: [], cover: null };

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

/** A client that does NOT retry, so a non-2xx settles as one clean rejection. */
const newClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// --- AC1: the request create ---------------------------------------------------

describe('useRequestBook — a create that COMMITS and then 502s (#168 AC1)', () => {
  /**
   * One authoritative request table. A create INSERTS an `approved` row (the auto-approve path) and
   * only then answers 502 — the transient-handoff-failure shape, where the row stays `approved` for
   * the poller to retry. `quota.used` is DERIVED from the committed rows the way `countInWindow`
   * does, so the quota claim below is observed rather than assumed.
   */
  function fakeServer() {
    const rows: RequestDto[] = [];
    const used = () => rows.filter((r) => (OPEN_REQUEST_STATUSES as readonly string[]).includes(r.status)).length;
    const me = (): MeDto =>
      baseMe({ quota: { mode: 'limited', limit: 10, used: used(), remaining: Math.max(0, 10 - used()), windowDays: 30 } });

    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url === '/api/me') return Promise.resolve(jsonRes(200, me()));
        if (url.startsWith('/api/requests')) {
          if (init?.method === 'POST') {
            // COMMIT — auto-approved insert — and only then the failing handoff tail.
            rows.push(request({ publicId: 'rq_2', asin: 'B02', title: 'Neuromancer', status: 'approved' }));
            return Promise.resolve(fail(502, 'UPSTREAM_ERROR', 'narratorr refused the handoff'));
          }
          return Promise.resolve(jsonRes(200, { data: rows, total: rows.length }));
        }
        throw new Error(`unstubbed fetch: ${init?.method ?? 'GET'} ${url}`);
      }),
    );
    return { rows };
  }

  it('the list AND the quota-bearing me query both converge on the committed row', async () => {
    const server = fakeServer();
    const { result } = renderHook(
      () => ({ mine: useMyRequests(), me: useMe(), create: useRequestBook() }),
      { wrapper: wrapper(newClient()) },
    );
    await waitFor(() => {
      expect(result.current.mine.isSuccess).toBe(true);
      expect(result.current.me.isSuccess).toBe(true);
    });
    expect(result.current.me.data?.quota.used).toBe(0); // baseline

    result.current.create.mutate(searchResult);

    // Premise: the mutation genuinely FAILED — we are on the error path…
    await waitFor(() => expect(result.current.create.isError).toBe(true));
    expect(server.rows).toHaveLength(1); // …and the row is durable anyway.

    await waitFor(() => {
      expect(result.current.mine.data?.data).toHaveLength(1);
      // The load-bearing half: an `approved` row occupies a quota slot, and nothing else refetches
      // `me` (no poll, 60s staleTime) — so without the settlement reconciliation QuotaMeter would
      // under-report for the rest of the session.
      expect(result.current.me.data?.quota).toMatchObject({ used: 1, remaining: 9 });
    });
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith('narratorr refused the handoff');
  });
});

// --- AC2: the admin decision ---------------------------------------------------

describe('useDecide — a decision that CLAIMS and then 502s (#168 AC2)', () => {
  /** The claim commits (`pending → approved`) before the fallible email + handoff tail. */
  function fakeServer() {
    let row = request({ status: 'pending' });
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url.includes('/decision')) {
          row = { ...row, status: 'approved', decidedAt: '2026-07-02T00:00:00.000Z' }; // COMMIT
          return Promise.resolve(fail(502, 'UPSTREAM_ERROR', 'handoff failed'));
        }
        if (url.startsWith('/api/admin/requests')) return Promise.resolve(jsonRes(200, { data: [row], total: 1 }));
        throw new Error(`unstubbed fetch: ${init?.method ?? 'GET'} ${url}`);
      }),
    );
    return { current: () => row };
  }

  // Mounts the ALL-STATUS queue (`useAdminQueue(undefined, …)`) rather than the page's default
  // `pending` filter (`AdminQueuePage.tsx`), where an approved row correctly DISAPPEARS — under that
  // filter "the row is gone" is indistinguishable from "the list never refetched". The all-status
  // observer is the one that can carry the new status positively (F6).
  it('the all-status queue observer converges on the approved row', async () => {
    const server = fakeServer();
    const { result } = renderHook(
      () => ({ queue: useAdminQueue(undefined, 50), decide: useDecide() }),
      { wrapper: wrapper(newClient()) },
    );
    await waitFor(() => expect(result.current.queue.isSuccess).toBe(true));
    expect(result.current.queue.data?.data[0]?.status).toBe('pending'); // baseline

    result.current.decide.mutate({ publicId: 'rq_1', action: 'approve' });

    await waitFor(() => expect(result.current.decide.isError).toBe(true));
    expect(server.current().status).toBe('approved'); // the claim is durable

    await waitFor(() => expect(result.current.queue.data?.data[0]?.status).toBe('approved'));
  });
});

// --- AC3: the admin user edit --------------------------------------------------

describe('useUpdateUser — a role change that COMMITS and then loses its response (#168 AC3)', () => {
  function fakeServer() {
    let row = user({ role: 'user' });
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url.startsWith('/api/admin/users')) {
          if (init?.method === 'PATCH') {
            const patch = JSON.parse(String(init.body)) as { role?: UserDto['role'] };
            row = { ...row, ...(patch.role ? { role: patch.role } : {}) }; // COMMIT (atomic UPDATE)
            return Promise.resolve(fail(500, 'INTERNAL', 'response lost after the write'));
          }
          return Promise.resolve(jsonRes(200, { data: [row], total: 1 }));
        }
        throw new Error(`unstubbed fetch: ${init?.method ?? 'GET'} ${url}`);
      }),
    );
    return { current: () => row };
  }

  it('the users observer converges on the new role — nothing else would ever refetch this key', async () => {
    const server = fakeServer();
    const { result } = renderHook(
      () => ({ users: useUsers(), update: useUpdateUser() }),
      { wrapper: wrapper(newClient()) },
    );
    await waitFor(() => expect(result.current.users.isSuccess).toBe(true));
    expect(result.current.users.data?.data[0]?.role).toBe('user'); // baseline

    result.current.update.mutate({ publicId: 'us_2', patch: { role: 'admin' } });

    await waitFor(() => expect(result.current.update.isError).toBe(true));
    expect(server.current().role).toBe('admin');

    await waitFor(() => expect(result.current.users.data?.data[0]?.role).toBe('admin'));
  });
});

// --- AC4/AC6: the self-scoped account save -------------------------------------

describe('useUpdateMe — a PARTIALLY committed save (#168 AC4)', () => {
  /**
   * Mirrors `routes/auth.ts`: `email` is written FIRST, `kindleEmail` second, `notifyOn` third, and
   * only then the shared `buildMeDto()` tail runs. This fake commits the email write and then throws
   * on the Kindle write — the genuine partial-commit shape, where the response never arrives at all
   * and `mergeMeCache` therefore never runs.
   */
  function fakeServer() {
    let row = baseMe({ email: 'old@ex.com', kindleEmail: 'old@kindle.com' });
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url === '/api/me') {
          if (init?.method === 'PATCH') {
            const body = JSON.parse(String(init.body)) as { email?: string | null; kindleEmail?: string | null };
            if ('email' in body) row = { ...row, email: body.email ?? null }; // COMMIT #1
            if ('kindleEmail' in body) return Promise.resolve(fail(500, 'INTERNAL', 'kindle write blew up'));
            return Promise.resolve(jsonRes(200, row));
          }
          return Promise.resolve(jsonRes(200, row));
        }
        throw new Error(`unstubbed fetch: ${init?.method ?? 'GET'} ${url}`);
      }),
    );
    return { current: () => row };
  }

  it('the me observer ends on the committed email while the failed field keeps its pre-write value', async () => {
    const server = fakeServer();
    const { result } = renderHook(() => ({ me: useMe(), save: useUpdateMe() }), { wrapper: wrapper(newClient()) });
    await waitFor(() => expect(result.current.me.isSuccess).toBe(true));

    result.current.save.mutate({ email: 'new@ex.com', kindleEmail: 'new@kindle.com' });

    await waitFor(() => expect(result.current.save.isError).toBe(true));
    // The server's own state: half the save landed. Asserting only the email half would also pass
    // against a fake that accidentally committed both (F7).
    expect(server.current()).toMatchObject({ email: 'new@ex.com', kindleEmail: 'old@kindle.com' });

    await waitFor(() => expect(result.current.me.data?.email).toBe('new@ex.com'));
    expect(result.current.me.data?.kindleEmail).toBe('old@kindle.com');
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith('kindle write blew up');
  });
});

describe('useUpdateMe — when the reconciliation READ fails too (#168 AC6 states 6/8)', () => {
  /**
   * `PATCH /api/me` and `GET /api/me` share `buildMeDto()`, so a save that commits and then 500s in
   * that tail is followed by a reconciliation GET that can fail on exactly the same thing. This fake
   * fails BOTH, then recovers — the premise AC6's retained-data rows rest on.
   */
  function fakeServer() {
    let row = baseMe({ email: 'old@ex.com' });
    const state = { failReads: true };
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url !== '/api/me') throw new Error(`unstubbed fetch: ${url}`);
        if (init?.method === 'PATCH') {
          const body = JSON.parse(String(init.body)) as { email?: string | null };
          if ('email' in body) row = { ...row, email: body.email ?? null }; // COMMIT
          return Promise.resolve(fail(500, 'INTERNAL', 'quota lookup blew up')); // …then the DTO tail
        }
        return state.failReads ? Promise.resolve(fail(500, 'INTERNAL', 'quota lookup blew up')) : Promise.resolve(jsonRes(200, row));
      }),
    );
    return { state, current: () => row };
  }

  it('leaves the me query errored WITH its previous data, then converges once reads recover', async () => {
    const server = fakeServer();
    server.state.failReads = false; // the first load succeeds
    const client = newClient();
    const { result } = renderHook(() => ({ me: useMe(), save: useUpdateMe() }), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.me.isSuccess).toBe(true));

    server.state.failReads = true;
    result.current.save.mutate({ email: 'new@ex.com' });
    await waitFor(() => expect(result.current.save.isError).toBe(true));

    // The reachable state AC6 rows 6/8 are about: errored, but the payload is RETAINED. The cache
    // reaches this before the observer does, so assert the query state first…
    await waitFor(() => {
      expect(client.getQueryState(qk.me)?.status).toBe('error');
      expect(client.getQueryState(qk.me)?.data).toMatchObject({ email: 'old@ex.com' });
    });
    // …then wait for the observer to actually carry it (it lags the cache on a refetch error).
    await waitFor(() => expect(result.current.me.isError).toBe(true));
    expect(result.current.me.data).toMatchObject({ email: 'old@ex.com' });

    // Once the tail stops failing, one more settlement converges on the committed row.
    server.state.failReads = false;
    await act(async () => {
      await client.invalidateQueries({ queryKey: qk.me });
    });
    await waitFor(() => expect(result.current.me.data?.email).toBe('new@ex.com'));
  });
});

// --- AC5: local auth -----------------------------------------------------------

describe('useLocalAuth — a session minted behind a response the client cannot read (#168 AC5)', () => {
  /**
   * `setSessionCookie()` runs BEFORE the response body is produced, so a signup can leave a VALID
   * SESSION behind a body `parse()` rejects. The fake models exactly that: the credentials POST
   * flips `/api/me` from 401 to a real DTO (the cookie), then answers with unparseable HTML.
   */
  function fakeServer(opts: { mintSession: boolean }) {
    const state = { signedIn: false, meGets: 0 };
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url === '/api/me') {
          state.meGets += 1;
          return state.signedIn
            ? Promise.resolve(jsonRes(200, baseMe()))
            : Promise.resolve(fail(401, 'UNAUTHORIZED', 'not signed in'));
        }
        if (url.startsWith('/api/auth/local/')) {
          if (opts.mintSession) {
            state.signedIn = true; // the Set-Cookie half of the response
            return Promise.resolve(unparseableRes(200)); // …the body half is garbage
          }
          return Promise.resolve(fail(401, 'UNAUTHORIZED', 'Invalid email or password'));
        }
        throw new Error(`unstubbed fetch: ${init?.method ?? 'GET'} ${url}`);
      }),
    );
    return state;
  }

  it('signup: the rejected attempt still recovers into a populated me query', async () => {
    fakeServer({ mintSession: true });
    const { result } = renderHook(() => ({ me: useMe(), auth: useLocalAuth('signup') }), {
      wrapper: wrapper(newClient()),
    });
    await waitFor(() => expect(result.current.me.isError).toBe(true)); // the login screen's 401

    result.current.auth.mutate({ email: 'a@b.c', password: 'pw' });

    await waitFor(() => expect(result.current.auth.isError).toBe(true)); // the body was unreadable…
    // …yet the session is real, so the settlement re-read lands the caller in the app rather than
    // stranding them on the login screen until a reload.
    await waitFor(() => expect(result.current.me.data?.publicId).toBe('us_1'));
  });

  it('login: a genuinely rejected attempt just re-reads the 401 and stays signed out', async () => {
    const state = fakeServer({ mintSession: false });
    const client = newClient();
    const { result } = renderHook(() => ({ me: useMe(), auth: useLocalAuth('login') }), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.me.isError).toBe(true));
    const readsBefore = state.meGets;

    result.current.auth.mutate({ email: 'a@b.c', password: 'wrong' });
    await waitFor(() => expect(result.current.auth.isError).toBe(true));

    // The reconciliation read is harmless here: it costs one GET that answers 401 again, leaving the
    // query in its error state with no data — `resolveMeShell` state 3, the login screen. Wait for
    // that GET to have been ISSUED AND SETTLED, so the absence assertion below isn't just observing
    // a read that hasn't started.
    await waitFor(() => expect(state.meGets).toBeGreaterThan(readsBefore));
    await waitFor(() => expect(client.getQueryState(qk.me)?.fetchStatus).toBe('idle'));
    expect(result.current.me.isError).toBe(true);
    expect(result.current.me.data).toBeUndefined();
  });
});

// --- The observer-vs-status guard used above -----------------------------------

describe('the paged queue key the decision row asserts through', () => {
  it('is nested under the prefix the decision invalidates (so the refetch actually reaches it)', () => {
    const status: RequestStatus | undefined = undefined;
    expect(qk.adminQueuePaged(status, 50).slice(0, qk.adminRequests.length)).toEqual(qk.adminRequests);
  });
});
