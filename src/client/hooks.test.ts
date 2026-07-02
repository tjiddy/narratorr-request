import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RequestDto } from '@shared/schemas/request';
import type { UserDto } from '@shared/schemas/user';
import type { ConnectorSettingsDto, TestConnectorResult } from '@shared/schemas/connectors';
// Type-only namespace imports (erased at runtime, so they don't fight the mocks below) —
// give importActual its return type without an inline `import()` annotation.
import type * as ApiModule from './api';
import type * as ReactModule from 'react';

// Node-only hook testing — no render harness. We mock @tanstack/react-query so
// `useMutation` and `useQuery` each return the options object passed to them (so
// the hook hands us its onSuccess/onError callbacks and derived query options
// directly) and `useQueryClient` returns a fake client of spies. `sonner`'s toast
// is spied so we can assert the surfaced text.
const hoisted = vi.hoisted(() => ({
  qc: { invalidateQueries: vi.fn(), setQueryData: vi.fn() },
  // Spies for the local-auth boundary functions and the three request-list wrappers
  // (so a paged hook's queryFn can be driven and its args asserted); the rest of `./api`
  // is preserved (importActual) so `ApiError` and unrelated exports stay real.
  api: {
    localLogin: vi.fn(),
    localSignup: vi.fn(),
    listMyRequests: vi.fn(),
    listAdminQueue: vi.fn(),
    listUserRequests: vi.fn(),
  },
  // A module-scoped slot backing the test-only `react` useState mock so a re-invoked
  // `useTheme()` observes the value a prior `toggleTheme()` wrote.
  react: { slot: undefined as unknown, initialized: false },
}));

vi.mock('@tanstack/react-query', () => ({
  useMutation: (options: unknown) => options,
  useQuery: (options: unknown) => options,
  useQueryClient: () => hoisted.qc,
  // The paged hooks now pass a scoped `keepSameListData(key)` function rather than this
  // sentinel (#115), but keep the export mocked so any incidental import still resolves.
  keepPreviousData: (prev: unknown) => prev,
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// Preserve every real `./api` export (notably `ApiError`, used below) and replace
// only the two local-auth boundary functions with spies.
vi.mock('./api', async (importActual) => {
  const actual = await importActual<typeof ApiModule>();
  return {
    ...actual,
    localLogin: hoisted.api.localLogin,
    localSignup: hoisted.api.localSignup,
    listMyRequests: hoisted.api.listMyRequests,
    listAdminQueue: hoisted.api.listAdminQueue,
    listUserRequests: hoisted.api.listUserRequests,
  };
});

// Test-only `react` mock: minimal stateful useState/useEffect so `useTheme()` runs
// as a plain function under the node harness — no jsdom, no render dispatcher. Only
// `useTheme` touches React directly; the TanStack hooks are mocked separately.
vi.mock('react', async (importActual) => {
  const actual = await importActual<typeof ReactModule>();
  return {
    ...actual,
    useState: (init: unknown) => {
      if (!hoisted.react.initialized) {
        hoisted.react.slot = typeof init === 'function' ? (init as () => unknown)() : init;
        hoisted.react.initialized = true;
      }
      const setter = (next: unknown) => {
        hoisted.react.slot =
          typeof next === 'function' ? (next as (prev: unknown) => unknown)(hoisted.react.slot) : next;
      };
      return [hoisted.react.slot, setter];
    },
    useEffect: (fn: () => void | (() => void)) => {
      fn();
    },
  };
});

import { toast } from 'sonner';
import {
  qk,
  samePagedList,
  keepSameListData,
  useRequestBook,
  useUpdateUser,
  useDecide,
  useUpdateConnectors,
  useTestConnector,
  useCreateNotifier,
  useUpdateNotifier,
  useDeleteNotifier,
  useTestNotifier,
  useSearch,
  useMyRequests,
  useMyRequestsPaged,
  useAdminQueue,
  useUserRequests,
  useUsers,
  useConnectorSettings,
  useSystemInfo,
  useAuthProviders,
  useLocalAuth,
  useTheme,
} from './hooks';
import { ApiError } from './api';

const success = vi.mocked(toast.success);
const error = vi.mocked(toast.error);

// The mocked `useMutation` returns the raw options object, but its declared return
// type is `UseMutationResult` (no onSuccess/onError). Cast to the callbacks we drive.
interface Callbacks {
  onSuccess: (...args: any[]) => unknown;
  onError: (...args: any[]) => unknown;
}
const cb = (hook: unknown): Callbacks => hook as Callbacks;

// `useMutation` returns the raw options; for the auth hook we drive its mutationFn.
interface MutationOptions {
  mutationFn: (vars: { email: string; password: string }) => unknown;
  onSuccess: () => unknown;
}
const mut = (hook: unknown): MutationOptions => hook as MutationOptions;

// `useQuery` now returns the raw options too — read the derived enabled/queryKey plus the
// paging wiring (queryFn / refetchInterval / placeholderData) the paged hooks set.
interface QueryOptions {
  enabled: boolean;
  queryKey: unknown;
  queryFn: () => unknown;
  refetchInterval?: number;
  placeholderData?: unknown;
}
const query = (hook: unknown): QueryOptions => hook as QueryOptions;

// The scoped `placeholderData` is a function `(prev, prevQuery) => data`. Cast it out of the
// `unknown` slot so a test can drive it directly (node-only — no render harness).
type PlaceholderFn = (prev: unknown, prevQuery?: { queryKey: readonly unknown[] }) => unknown;
const placeholder = (q: QueryOptions): PlaceholderFn => q.placeholderData as PlaceholderFn;

// Minimal cast helpers — the callbacks only read the few fields we set.
const req = (over: Partial<RequestDto>): RequestDto => ({ title: 'Dune', status: 'pending', ...over } as RequestDto);

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  // Restore ambient globals stubbed by the useTheme cases and reset the React state
  // slot so each invocation re-runs the useState initializer. Harmless to tests that
  // stub nothing.
  vi.unstubAllGlobals();
  hoisted.react.slot = undefined;
  hoisted.react.initialized = false;
});

describe('qk query-key builders', () => {
  it('builds the static and parameterized keys', () => {
    expect(qk.me).toEqual(['me']);
    expect(qk.myRequests).toEqual(['requests', 'mine']);
    expect(qk.search('')).toEqual(['search', '']);
    expect(qk.search('a')).toEqual(['search', 'a']);
    expect(qk.search('')).not.toEqual(qk.search('a'));
  });

  it('collapses an absent admin-queue status to "all"', () => {
    expect(qk.adminQueue(undefined)).toEqual(['admin', 'requests', 'all']);
    expect(qk.adminQueue('pending')).toEqual(['admin', 'requests', 'pending']);
  });

  // Registry stability (AC5): each moved key's serialized value must equal its former
  // inline literal, so the centralization refactor churns no cache keys.
  it('preserves the serialized value of every centralized key (no cache-key churn)', () => {
    expect(qk.adminRequests).toEqual(['admin', 'requests']);
    expect(qk.users).toEqual(['admin', 'users']);
    expect(qk.connectors).toEqual(['admin', 'settings', 'connectors']);
    expect(qk.system).toEqual(['admin', 'system']);
    expect(qk.authProviders).toEqual(['auth', 'providers']);
  });
});

// F2 — pin the AC-critical paged hook wiring so a future edit can't silently drop the
// limit-keyed cache, the `{ limit }` pass-through, the polling interval, or the scoped
// placeholder. The mocked useQuery returns its raw options, so we read queryKey/queryFn/etc.
// directly and drive queryFn against the mocked api spies (node-only — no jsdom/component
// modality).
describe('paged request list hooks — key isolation, limit pass-through, polling, scoped placeholder', () => {
  it('useMyRequestsPaged keys by limit, passes { limit }, polls at 4s, scopes the placeholder', async () => {
    const q = query(useMyRequestsPaged(100));
    expect(q.queryKey).toEqual(qk.myRequestsPaged(100));
    expect(q.queryKey).toEqual(['requests', 'mine', 'paged', 100]);
    // Nests under the bare `['requests','mine']` prefix a request mutation invalidates,
    // so invalidating that prefix still refetches every loaded page.
    expect((q.queryKey as unknown[]).slice(0, 2)).toEqual(qk.myRequests);
    expect(q.refetchInterval).toBe(4000);
    // No longer the bare keepPreviousData sentinel — a scoped function closing over the key.
    expect(typeof q.placeholderData).toBe('function');
    await q.queryFn();
    expect(hoisted.api.listMyRequests).toHaveBeenCalledWith({ limit: 100 });
  });

  it('bare useMyRequests (Search) stays on the bare key and requests the bare API — no limit (AC5)', async () => {
    const q = query(useMyRequests());
    expect(q.queryKey).toEqual(qk.myRequests);
    expect(q.refetchInterval).toBe(4000);
    await q.queryFn();
    expect(hoisted.api.listMyRequests).toHaveBeenCalledWith(); // no args → bare /api/requests
  });

  it('useAdminQueue keys by status+limit, passes status+{ limit }, polls at 5s, scopes the placeholder', async () => {
    const q = query(useAdminQueue('pending', 100));
    expect(q.queryKey).toEqual(qk.adminQueuePaged('pending', 100));
    expect(q.queryKey).toEqual(['admin', 'requests', 'pending', 100]);
    expect(q.refetchInterval).toBe(5000);
    expect(typeof q.placeholderData).toBe('function');
    await q.queryFn();
    expect(hoisted.api.listAdminQueue).toHaveBeenCalledWith('pending', { limit: 100 });
  });

  it('useAdminQueue collapses an absent status to the "all" key and nests under the admin-requests prefix', async () => {
    const q = query(useAdminQueue(undefined, 50));
    expect(q.queryKey).toEqual(['admin', 'requests', 'all', 50]);
    expect((q.queryKey as unknown[]).slice(0, 2)).toEqual(['admin', 'requests']);
    await q.queryFn();
    expect(hoisted.api.listAdminQueue).toHaveBeenCalledWith(undefined, { limit: 50 });
  });

  it('useUserRequests keys by user+limit, passes { limit }, scopes the placeholder', async () => {
    const q = query(useUserRequests('us_abc', 150));
    expect(q.queryKey).toEqual(qk.userRequests('us_abc', 150));
    expect(q.queryKey).toEqual(['admin', 'users', 'us_abc', 'requests', 150]);
    expect(typeof q.placeholderData).toBe('function');
    await q.queryFn();
    expect(hoisted.api.listUserRequests).toHaveBeenCalledWith('us_abc', { limit: 150 });
  });
});

// #115 — the scoped placeholder comparator. `keepPreviousData` was over-applied: a filter
// or user switch (a non-limit key-segment change) briefly rendered the prior list's rows as
// current instead of "Loading…". `samePagedList` / `keepSameListData` restrict the retention
// to a growing-limit page of the *same* list. Pure logic — driven directly (node-only).
describe('samePagedList — retain only across a limit change of the same list', () => {
  it('is true when the keys differ only in the trailing (limit) element', () => {
    expect(samePagedList(['admin', 'requests', 'pending', 50], ['admin', 'requests', 'pending', 100])).toBe(true);
  });

  it('is false when a non-limit segment differs (filter switch)', () => {
    expect(samePagedList(['admin', 'requests', 'pending', 50], ['admin', 'requests', 'active', 50])).toBe(false);
  });

  it('is false when a non-limit segment differs (user switch)', () => {
    expect(
      samePagedList(['admin', 'users', 'us_a', 'requests', 50], ['admin', 'users', 'us_b', 'requests', 50]),
    ).toBe(false);
  });

  it('is false when the key lengths differ', () => {
    expect(samePagedList(['admin', 'requests', 'pending', 50], ['admin', 'requests', 'pending'])).toBe(false);
  });
});

describe('keepSameListData — drop the placeholder across a filter/user switch, keep it on limit growth', () => {
  const prevData = [{ title: 'Dune' }];

  it('returns the prev data when the prior query is the same list at a different limit', () => {
    const fn = keepSameListData(['admin', 'requests', 'pending', 100]);
    expect(fn(prevData, { queryKey: ['admin', 'requests', 'pending', 50] })).toBe(prevData);
  });

  it('returns undefined when a non-limit segment differs (loading returns)', () => {
    const fn = keepSameListData(['admin', 'requests', 'pending', 50]);
    expect(fn(prevData, { queryKey: ['admin', 'requests', 'active', 50] })).toBeUndefined();
  });

  it('returns undefined when there is no prior data', () => {
    const fn = keepSameListData(['admin', 'requests', 'pending', 100]);
    expect(fn(undefined, { queryKey: ['admin', 'requests', 'pending', 50] })).toBeUndefined();
  });

  it('returns undefined when the prior query is absent', () => {
    const fn = keepSameListData(['admin', 'requests', 'pending', 100]);
    expect(fn(prevData, undefined)).toBeUndefined();
  });
});

// AC1/AC2/AC3/AC4 — drive each hook's actual `placeholderData` function with a prior query to
// prove the wired-in behavior: filter/user switch drops the placeholder (loading returns),
// limit growth of the same list keeps it (Load-more retention preserved).
describe('paged hooks scope the placeholder to same-list limit growth', () => {
  const prevData = [{ title: 'Dune' }];

  it('useAdminQueue drops the placeholder on a filter switch but keeps it on limit growth', () => {
    const fn = placeholder(query(useAdminQueue('pending', 100)));
    // Prior page was the `active` filter → different list → loading returns.
    expect(fn(prevData, { queryKey: ['admin', 'requests', 'active', 50] })).toBeUndefined();
    // Prior page was the same `pending` filter at a smaller limit → retain the rows.
    expect(fn(prevData, { queryKey: ['admin', 'requests', 'pending', 50] })).toBe(prevData);
  });

  it('useUserRequests drops the placeholder on a user switch but keeps it on limit growth', () => {
    const fn = placeholder(query(useUserRequests('us_b', 150)));
    // Prior page was a different user → loading returns.
    expect(fn(prevData, { queryKey: ['admin', 'users', 'us_a', 'requests', 50] })).toBeUndefined();
    // Prior page was the same user at a smaller limit → retain the rows.
    expect(fn(prevData, { queryKey: ['admin', 'users', 'us_b', 'requests', 50] })).toBe(prevData);
  });

  it('useMyRequestsPaged (limit-only key) still keeps the prev data across a limit change (AC3/AC4)', () => {
    const fn = placeholder(query(useMyRequestsPaged(100)));
    expect(fn(prevData, { queryKey: ['requests', 'mine', 'paged', 50] })).toBe(prevData);
  });
});

// AC1/AC3 — the query hooks whose keys moved into `qk` must read from the registry entry,
// and the two broad invalidations (users, admin-requests) must stay prefixes of the paged
// keys they refresh. Reading `.queryKey` off the mocked useQuery options (no jsdom).
describe('centralized read-site keys + prefix guards', () => {
  it('useUsers keys on qk.users, a prefix of qk.userRequests', () => {
    expect(query(useUsers()).queryKey).toEqual(qk.users);
    // Broad invalidate of qk.users still refreshes every per-user request list.
    expect(qk.userRequests('us_abc', 150).slice(0, qk.users.length)).toEqual(qk.users);
  });

  it('qk.adminRequests is a prefix of both admin-queue key variants', () => {
    expect(qk.adminQueue('pending').slice(0, qk.adminRequests.length)).toEqual(qk.adminRequests);
    expect(qk.adminQueue(undefined).slice(0, qk.adminRequests.length)).toEqual(qk.adminRequests);
    expect(qk.adminQueuePaged('pending', 100).slice(0, qk.adminRequests.length)).toEqual(qk.adminRequests);
    expect(qk.adminQueuePaged(undefined, 50).slice(0, qk.adminRequests.length)).toEqual(qk.adminRequests);
  });

  it('useConnectorSettings keys on qk.connectors', () => {
    expect(query(useConnectorSettings()).queryKey).toEqual(qk.connectors);
  });

  it('useSystemInfo keys on qk.system', () => {
    expect(query(useSystemInfo()).queryKey).toEqual(qk.system);
  });

  it('useAuthProviders keys on qk.authProviders', () => {
    expect(query(useAuthProviders()).queryKey).toEqual(qk.authProviders);
  });
});

describe('useRequestBook', () => {
  it('toasts "already available" and invalidates myRequests + me on an available result', () => {
    cb(useRequestBook()).onSuccess(req({ status: 'available', title: 'Dune' }));
    expect(success).toHaveBeenCalledWith('“Dune” is already available!');
    expect(hoisted.qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: qk.myRequests });
    expect(hoisted.qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: qk.me });
    // Keys must equal the qk definitions verbatim (no drift).
    expect(hoisted.qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['requests', 'mine'] });
    expect(hoisted.qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['me'] });
  });

  it('toasts "Requested" for a non-available result', () => {
    cb(useRequestBook()).onSuccess(req({ status: 'pending', title: 'Dune' }));
    expect(success).toHaveBeenCalledWith('Requested “Dune”');
  });

  it('surfaces an ApiError message, else the generic fallback, on error', () => {
    const h = cb(useRequestBook());
    h.onError(new ApiError(400, 'BAD', 'boom'));
    expect(error).toHaveBeenCalledWith('boom');
    h.onError(new Error('raw'));
    expect(error).toHaveBeenCalledWith('Request failed');
  });
});

describe('useDecide', () => {
  it('toasts Approved/Denied with curly quotes and invalidates the admin-requests prefix', () => {
    const h = cb(useDecide());
    h.onSuccess(req({ title: 'Dune' }), { action: 'approve' });
    expect(success).toHaveBeenCalledWith('Approved “Dune”');
    h.onSuccess(req({ title: 'Dune' }), { action: 'deny' });
    expect(success).toHaveBeenCalledWith('Denied “Dune”');
    // DRY-1 guard: the invalidation keys on qk.adminRequests, which stays a prefix of
    // both admin-queue key variants so every loaded queue page still refetches.
    expect(hoisted.qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: qk.adminRequests });
    expect(qk.adminQueue(undefined).slice(0, qk.adminRequests.length)).toEqual(qk.adminRequests);
    expect(qk.adminQueuePaged('pending', 100).slice(0, qk.adminRequests.length)).toEqual(qk.adminRequests);
  });

  it('surfaces ApiError message, else "Action failed", on error', () => {
    const h = cb(useDecide());
    h.onError(new ApiError(409, 'C', 'conflict'));
    expect(error).toHaveBeenCalledWith('conflict');
    h.onError(new Error('x'));
    expect(error).toHaveBeenCalledWith('Action failed');
  });
});

describe('useUpdateUser', () => {
  const user = { username: 'todd' } as UserDto;

  it('toasts the saved username and invalidates admin/users', () => {
    cb(useUpdateUser()).onSuccess(user);
    expect(success).toHaveBeenCalledWith('Saved changes to todd');
    expect(hoisted.qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: qk.users });
  });

  it('surfaces ApiError message, else "Failed to update user", on error', () => {
    const h = cb(useUpdateUser());
    h.onError(new ApiError(400, 'B', 'bad patch'));
    expect(error).toHaveBeenCalledWith('bad patch');
    h.onError(new Error('x'));
    expect(error).toHaveBeenCalledWith('Failed to update user');
  });
});

describe('useUpdateConnectors', () => {
  const dto = { publicUrl: null } as ConnectorSettingsDto;

  it('writes the connectors cache directly (not invalidate) and toasts "Settings saved"', () => {
    cb(useUpdateConnectors()).onSuccess(dto);
    expect(hoisted.qc.setQueryData).toHaveBeenCalledWith(qk.connectors, dto);
    expect(success).toHaveBeenCalledWith('Settings saved');
    expect(hoisted.qc.invalidateQueries).not.toHaveBeenCalled();
  });

  it('surfaces ApiError message, else "Save failed", on error', () => {
    const h = cb(useUpdateConnectors());
    h.onError(new ApiError(422, 'V', 'invalid url'));
    expect(error).toHaveBeenCalledWith('invalid url');
    h.onError(new Error('x'));
    expect(error).toHaveBeenCalledWith('Save failed');
  });
});

describe('useTestConnector', () => {
  it('routes a success result to toast.success and a failure to toast.error', () => {
    const h = cb(useTestConnector());
    h.onSuccess({ success: true, message: 'Connected' } as TestConnectorResult);
    expect(success).toHaveBeenCalledWith('Connected');
    h.onSuccess({ success: false, message: 'Unauthorized' } as TestConnectorResult);
    expect(error).toHaveBeenCalledWith('Unauthorized');
  });

  it('surfaces ApiError message, else "Test failed", on error', () => {
    const h = cb(useTestConnector());
    h.onError(new ApiError(500, 'E', 'upstream down'));
    expect(error).toHaveBeenCalledWith('upstream down');
    h.onError(new Error('x'));
    expect(error).toHaveBeenCalledWith('Test failed');
  });
});

describe('notifier mutation hooks — cache invalidation + toast contract', () => {
  // The notifier list is carried by the connectors query, so create/update/delete must
  // invalidate that exact key (not setQueryData) to refetch the committed list + reset
  // freshly-masked secrets. All three assert the shared qk.connectors entry, so a drift
  // between the four connectors sites would fail here.

  it('useCreateNotifier invalidates the connectors key and toasts "Notifier added"', () => {
    cb(useCreateNotifier()).onSuccess();
    expect(hoisted.qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: qk.connectors });
    expect(hoisted.qc.setQueryData).not.toHaveBeenCalled();
    expect(success).toHaveBeenCalledWith('Notifier added');
  });

  it('useCreateNotifier surfaces ApiError message, else "Could not add notifier"', () => {
    const h = cb(useCreateNotifier());
    h.onError(new ApiError(400, 'B', 'bad notifier'));
    expect(error).toHaveBeenCalledWith('bad notifier');
    h.onError(new Error('x'));
    expect(error).toHaveBeenCalledWith('Could not add notifier');
  });

  it('useUpdateNotifier invalidates the connectors key and toasts "Notifier saved"', () => {
    cb(useUpdateNotifier()).onSuccess();
    expect(hoisted.qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: qk.connectors });
    expect(success).toHaveBeenCalledWith('Notifier saved');
  });

  it('useUpdateNotifier surfaces ApiError message, else "Could not save notifier"', () => {
    const h = cb(useUpdateNotifier());
    h.onError(new ApiError(404, 'N', 'gone'));
    expect(error).toHaveBeenCalledWith('gone');
    h.onError(new Error('x'));
    expect(error).toHaveBeenCalledWith('Could not save notifier');
  });

  it('useDeleteNotifier invalidates the connectors key and toasts "Notifier deleted"', () => {
    cb(useDeleteNotifier()).onSuccess();
    expect(hoisted.qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: qk.connectors });
    expect(success).toHaveBeenCalledWith('Notifier deleted');
  });

  it('useDeleteNotifier surfaces ApiError message, else "Could not delete notifier"', () => {
    const h = cb(useDeleteNotifier());
    h.onError(new ApiError(404, 'N', 'missing'));
    expect(error).toHaveBeenCalledWith('missing');
    h.onError(new Error('x'));
    expect(error).toHaveBeenCalledWith('Could not delete notifier');
  });
});

describe('useTestNotifier — routes the probe result to a toast', () => {
  it('routes a success result to toast.success and a failure to toast.error', () => {
    const h = cb(useTestNotifier());
    h.onSuccess({ success: true, message: 'Test notification sent.' } as TestConnectorResult);
    expect(success).toHaveBeenCalledWith('Test notification sent.');
    h.onSuccess({ success: false, message: 'webhook responded 500' } as TestConnectorResult);
    expect(error).toHaveBeenCalledWith('webhook responded 500');
  });

  it('surfaces ApiError message, else "Test failed", on error', () => {
    const h = cb(useTestNotifier());
    h.onError(new ApiError(500, 'E', 'upstream down'));
    expect(error).toHaveBeenCalledWith('upstream down');
    h.onError(new Error('x'));
    expect(error).toHaveBeenCalledWith('Test failed');
  });

  it('does not touch the connectors cache (a probe never mutates state)', () => {
    cb(useTestNotifier()).onSuccess({ success: true, message: 'ok' } as TestConnectorResult);
    expect(hoisted.qc.invalidateQueries).not.toHaveBeenCalled();
    expect(hoisted.qc.setQueryData).not.toHaveBeenCalled();
  });
});

describe('useSearch enabled predicate + query key', () => {
  it('disables the query for an empty or whitespace-only input', () => {
    expect(query(useSearch('')).enabled).toBe(false);
    expect(query(useSearch('   ')).enabled).toBe(false);
    expect(query(useSearch('\t\n')).enabled).toBe(false);
  });

  it('enables the query once there is a non-whitespace character (raw or padded)', () => {
    expect(query(useSearch('a')).enabled).toBe(true);
    expect(query(useSearch('  a  ')).enabled).toBe(true);
  });

  it('keys the query by the raw (un-trimmed) input via qk.search', () => {
    expect(query(useSearch('  a  ')).queryKey).toEqual(qk.search('  a  '));
    expect(query(useSearch('a')).queryKey).toEqual(['search', 'a']);
  });
});

describe('useLocalAuth', () => {
  it('dispatches localLogin (not localSignup) with the exact credentials for mode=login', () => {
    mut(useLocalAuth('login')).mutationFn({ email: 'a@b.c', password: 'pw' });
    expect(hoisted.api.localLogin).toHaveBeenCalledWith('a@b.c', 'pw');
    expect(hoisted.api.localSignup).not.toHaveBeenCalled();
  });

  it('dispatches localSignup (not localLogin) with the exact credentials for mode=signup', () => {
    mut(useLocalAuth('signup')).mutationFn({ email: 'x@y.z', password: 'pw2' });
    expect(hoisted.api.localSignup).toHaveBeenCalledWith('x@y.z', 'pw2');
    expect(hoisted.api.localLogin).not.toHaveBeenCalled();
  });

  it('invalidates the me query on success (exact ["me"] key)', () => {
    mut(useLocalAuth('login')).onSuccess();
    expect(hoisted.qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: qk.me });
    expect(hoisted.qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['me'] });
  });
});

describe('useTheme', () => {
  // Stub the ambient inputs useTheme reads: localStorage (get/set), window.matchMedia,
  // and document.documentElement.classList (add/remove). Returns the spies to assert on.
  function setupTheme(opts: { stored: string | null; prefersDark?: boolean }) {
    const getItem = vi.fn((): string | null => opts.stored);
    const setItem = vi.fn();
    const matchMedia = vi.fn(() => ({ matches: opts.prefersDark ?? false }));
    const add = vi.fn();
    const remove = vi.fn();
    vi.stubGlobal('localStorage', { getItem, setItem });
    vi.stubGlobal('window', { matchMedia });
    vi.stubGlobal('document', { documentElement: { classList: { add, remove } } });
    return { getItem, setItem, matchMedia, add, remove };
  }

  it('initializes from a persisted "dark" theme and reflects it onto the dom + storage', () => {
    const m = setupTheme({ stored: 'dark' });
    const { theme } = useTheme();
    expect(theme).toBe('dark');
    // Lock the read contract: the persisted value comes from the exact 'theme' key.
    expect(m.getItem).toHaveBeenCalledWith('theme');
    expect(m.add).toHaveBeenCalledWith('dark');
    expect(m.remove).not.toHaveBeenCalled();
    expect(m.setItem).toHaveBeenCalledWith('theme', 'dark');
  });

  it('initializes from a persisted "light" theme and removes the dark class', () => {
    const m = setupTheme({ stored: 'light' });
    const { theme } = useTheme();
    expect(theme).toBe('light');
    expect(m.getItem).toHaveBeenCalledWith('theme');
    expect(m.remove).toHaveBeenCalledWith('dark');
    expect(m.add).not.toHaveBeenCalled();
    expect(m.setItem).toHaveBeenCalledWith('theme', 'light');
  });

  it('falls back to matchMedia (prefers dark) when no theme is persisted', () => {
    const m = setupTheme({ stored: null, prefersDark: true });
    expect(useTheme().theme).toBe('dark');
    // Lock the fallback contract: the OS preference is read via the exact dark-scheme query.
    expect(m.getItem).toHaveBeenCalledWith('theme');
    expect(m.matchMedia).toHaveBeenCalledWith('(prefers-color-scheme: dark)');
  });

  it('falls back to matchMedia (prefers light) when no theme is persisted', () => {
    const m = setupTheme({ stored: null, prefersDark: false });
    expect(useTheme().theme).toBe('light');
    expect(m.matchMedia).toHaveBeenCalledWith('(prefers-color-scheme: dark)');
  });

  it('toggleTheme flips the theme and persists + reflects the new value on re-invoke', () => {
    const m = setupTheme({ stored: 'light' });
    const first = useTheme();
    expect(first.theme).toBe('light');
    first.toggleTheme();
    // Re-invoke: the mocked useState reads the slot the toggle wrote (no re-init).
    const second = useTheme();
    expect(second.theme).toBe('dark');
    expect(m.setItem).toHaveBeenLastCalledWith('theme', 'dark');
    expect(m.add).toHaveBeenLastCalledWith('dark');
  });
});
