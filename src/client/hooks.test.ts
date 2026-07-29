import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RequestDto } from '@shared/schemas/request';
import type { UserDto, MeDto } from '@shared/schemas/user';
import type { ConnectorSettingsDto, TestConnectorResult, UpdateConnectorSettingsBody } from '@shared/schemas/connectors';
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
    updateMe: vi.fn(),
    updateConnectorSettings: vi.fn(),
    getFeatures: vi.fn(),
    sendEbookToKindle: vi.fn(),
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
    updateMe: hoisted.api.updateMe,
    updateConnectorSettings: hoisted.api.updateConnectorSettings,
    getFeatures: hoisted.api.getFeatures,
    sendEbookToKindle: hoisted.api.sendEbookToKindle,
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
  useUpdateMe,
  useDecide,
  useUpdateConnectors,
  useUpdateKindleSender,
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
  useUpdateEbooksEnabled,
  useFeatures,
  useSendToKindle,
  useSystemInfo,
  useAuthProviders,
  useLocalAuth,
  useTheme,
} from './hooks';
import { ApiError } from './api';
import { EBOOK_SEND_OUTCOMES } from '@shared/schemas/ebooks';
import { sendOutcomeMessage, sendErrorMessage, GENERIC_SEND_ERROR } from './components/ebook-sheet';

const success = vi.mocked(toast.success);
const error = vi.mocked(toast.error);

// The mocked `useMutation` returns the raw options object, but its declared return
// type is `UseMutationResult` (no onSuccess/onError). Cast to the callbacks we drive.
interface Callbacks {
  onSuccess: (...args: any[]) => unknown;
  onError: (...args: any[]) => unknown;
  /** Cache reconciliation lives here, not on onSuccess — a settings write can commit and 500. */
  onSettled: (...args: any[]) => unknown;
}
const cb = (hook: unknown): Callbacks => hook as Callbacks;

// `useMutation` returns the raw options; for the auth hook we drive its mutationFn.
interface MutationOptions {
  mutationFn: (vars: { email: string; password: string }) => unknown;
  onSuccess: () => unknown;
}
const mut = (hook: unknown): MutationOptions => hook as MutationOptions;

// A hook's `mutationFn` typed to its own body — lets a test drive the real API call the
// mutation makes (not just its settled callbacks) and assert the exact payload it sends.
const mutFn = <TBody>(hook: unknown): ((body: TBody) => Promise<unknown>) =>
  (hook as { mutationFn: (body: TBody) => Promise<unknown> }).mutationFn;

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

// A COMPLETE RequestDto, deliberately un-cast: the callbacks under test only read `title` and
// `status`, but building the whole shape is what makes a newly-required response field (e.g.
// `companionEbook`, issue #147) a compile error HERE rather than something a `as RequestDto`
// silently absorbs.
const req = (over: Partial<RequestDto> = {}): RequestDto => ({
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
  requester: { publicId: 'us_1', username: 'ann' },
  ...over,
});
// Still a cast: MeDto's unread half is large and not what any receipt here turns on.
const meDto = (over: Partial<MeDto>): MeDto =>
  ({ publicId: 'us_1', username: 'ann', role: 'user', status: 'active', ...over }) as MeDto;

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
    expect(qk.features).toEqual(['features']);
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

  // AC24/AC25 (#144) — the features query's key, fetcher and the active-only enablement. Without
  // this the hook could key elsewhere, call the wrong endpoint, or fire on the login /
  // pending / rejected screens, where `/api/features` only ever 401s or 403s.
  it('useFeatures keys on qk.features and fetches through getFeatures', async () => {
    const q = query(useFeatures(meDto({ status: 'active' })));
    expect(q.queryKey).toEqual(qk.features);
    expect(q.queryKey).toEqual(['features']);
    hoisted.api.getFeatures.mockResolvedValue({ ebooksEnabled: true, kindleDeliveryAvailable: false, kindleSenderEmail: null });
    await q.queryFn();
    expect(hoisted.api.getFeatures).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a signed-out caller', undefined, false],
    ['a pending account', meDto({ status: 'pending' }), false],
    ['a rejected account', meDto({ status: 'rejected' }), false],
    ['an active user', meDto({ status: 'active' }), true],
    ['an admin (never gated by the queue)', meDto({ role: 'admin', status: 'pending' }), true],
  ] as const)('useFeatures is enabled=%s for %s', (_label, me, expected) => {
    expect(query(useFeatures(me)).enabled).toBe(expected);
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

describe('useUpdateMe — account save with proportional feedback (#50, #134)', () => {
  // F2 — the mutation owns observable behavior beyond the pure helpers: it dispatches the PATCH via
  // `updateMe`, writes the returned MeDto straight into the `qk.me` cache (so the control reflects the
  // new set immediately), and surfaces success/error toasts. The success toast is proportional to the
  // payload (#134) via the pure `meSuccessToast` helper: an email save acknowledges, a notifyOn-only
  // toggle is silent. Node-only (mocked useMutation returns raw options), mirroring the other
  // mutation-hook tests here. onSuccess receives `(dto, body)` — the mutation variables carry the shape.
  const dto = { notifyOn: ['available'], emailNotifyAvailable: true } as unknown as MeDto;

  it('dispatches updateMe with the exact opt-in body', () => {
    mut(useUpdateMe()).mutationFn({ notifyOn: ['available'] } as never);
    expect(hoisted.api.updateMe).toHaveBeenCalledWith({ notifyOn: ['available'] });
  });

  // The cache write is a FUNCTIONAL update (#142 F1): the two account rows own independent mutation
  // instances, so an earlier request settling last must not roll back a newer sibling save. Drive the
  // updater the hook handed to setQueryData and assert the folded RESULT, not just that it was called.
  const applyMeUpdate = (call: number, prev: MeDto | undefined): MeDto => {
    const [key, updater] = hoisted.qc.setQueryData.mock.calls[call] as [
      unknown,
      (p: MeDto | undefined) => MeDto,
    ];
    expect(key).toEqual(['me']); // key verbatim, no drift
    return updater(prev);
  };

  it('folds the returned DTO into the me cache directly (not invalidate) for every payload shape', () => {
    const cached = { email: 'old@x.com', kindleEmail: 'old@kindle.com', notifyOn: [] } as unknown as MeDto;
    const response = {
      email: 'new@x.com',
      kindleEmail: null, // a stale sibling snapshot from a concurrent save
      notifyOn: ['available'],
    } as unknown as MeDto;

    cb(useUpdateMe()).onSuccess(response, { email: 'new@x.com' });
    // The body wrote only `email`, so only `email` is taken from the response.
    expect(applyMeUpdate(0, cached)).toMatchObject({
      email: 'new@x.com',
      kindleEmail: 'old@kindle.com',
      notifyOn: [],
    });

    cb(useUpdateMe()).onSuccess(response, { notifyOn: ['available'] });
    expect(applyMeUpdate(1, cached)).toMatchObject({
      email: 'old@x.com',
      kindleEmail: 'old@kindle.com',
      notifyOn: ['available'],
    });

    expect(hoisted.qc.setQueryData).toHaveBeenCalledTimes(2);
    expect(hoisted.qc.invalidateQueries).not.toHaveBeenCalled();
  });

  // Positive case FIRST — this must pass before the absence assertion below is trusted (non-vacuous).
  it('toasts exactly "Email saved" on an email-carrying save (set or null-clear)', () => {
    cb(useUpdateMe()).onSuccess(dto, { email: 'new@x.com' });
    expect(success).toHaveBeenCalledWith('Email saved');
    cb(useUpdateMe()).onSuccess(dto, { email: null }); // clearing still acknowledges
    expect(success).toHaveBeenCalledTimes(2);
    expect(success).toHaveBeenLastCalledWith('Email saved');
  });

  it('is silent on a notifyOn-only save — no success toast (the checkbox state is the confirmation)', () => {
    cb(useUpdateMe()).onSuccess(dto, { notifyOn: ['available'] });
    expect(success).not.toHaveBeenCalled();
    // Cache write still happens — silence is only about the toast.
    expect(hoisted.qc.setQueryData).toHaveBeenCalledWith(qk.me, expect.any(Function));
    expect(applyMeUpdate(0, undefined)).toBe(dto); // no prior entry ⇒ the response is taken whole
  });

  it('surfaces ApiError message, else "Could not save preferences", on error (unchanged for both shapes)', () => {
    const h = cb(useUpdateMe());
    h.onError(new ApiError(400, 'B', 'bad opt-in'));
    expect(error).toHaveBeenCalledWith('bad opt-in');
    h.onError(new Error('x'));
    expect(error).toHaveBeenCalledWith('Could not save preferences');
  });
});

describe('useUpdateConnectors', () => {
  const dto = { publicUrl: null } as ConnectorSettingsDto;

  it('INVALIDATES the connectors cache (never setQueryData) and toasts "Settings saved"', () => {
    // It used to write `dto` wholesale. That is a lost-update race now that Public URL, quota,
    // Narratorr and the ebook toggle each own a save against this one key: the response that
    // settles last overwrites the entry with a snapshot that may predate a sibling's committed
    // write (#160). Convergence is asserted end-to-end against a real QueryClient in
    // `hooks.connector-cache.test.tsx`; this row pins the operation that makes it possible.
    cb(useUpdateConnectors()).onSettled(dto, null, {});
    expect(hoisted.qc.setQueryData).not.toHaveBeenCalled();
    expect(hoisted.qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: qk.connectors });
    cb(useUpdateConnectors()).onSuccess();
    expect(success).toHaveBeenCalledWith('Settings saved');
  });

  // F2 — a narratorr connection swap retires the server's capability generation
  // (`reconfigure(narratorrChanged)`), so a mounted `useFeatures` must be told to refetch. A
  // `staleTime` lapse alone only MARKS data stale; it schedules nothing.
  it('retires the derived feature query on a NARRATORR write', () => {
    cb(useUpdateConnectors()).onSettled(dto, null, { narratorr: { url: 'http://n:3000', apiKey: 'k' } });
    expect(hoisted.qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: qk.features });
  });

  it('clearing the narratorr connection (null) also retires it', () => {
    // `null` is a real write — it disconnects narratorr, which definitively drops the capability.
    cb(useUpdateConnectors()).onSettled(dto, null, { narratorr: null });
    expect(hoisted.qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: qk.features });
  });

  it.each([
    ['publicUrl only', { publicUrl: 'https://app.example.com' }],
    ['defaultQuota only', { defaultQuota: { mode: 'unlimited' as const, windowDays: 30 as const } }],
  ])('does NOT retire the feature query for %s — it cannot change the derived payload', (_label, body) => {
    // Mirrors the server's own trigger set: `reconfigure()` bumps the generation only when
    // `body.narratorr !== undefined`. Over-invalidating here would cost a refetch on every
    // unrelated General save.
    cb(useUpdateConnectors()).onSettled(dto, null, body);
    expect(hoisted.qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: qk.connectors });
    expect(hoisted.qc.invalidateQueries).not.toHaveBeenCalledWith({ queryKey: qk.features });
  });

  // F5 — the route persists BEFORE awaiting its fallible reconfiguration tail
  // (`routes/settings.ts`), so a 500 is not evidence that nothing was written; the server's own
  // rejecting-tail tests assert exactly that pairing.
  //
  // SCOPE OF THIS ROW: it proves only that the error path REQUESTS the right invalidations. That
  // the mounted observers then converge on the committed row is a consequence this mocked
  // modality structurally cannot express (no cache, no observer, no refetch — see the file
  // header), and is proven at the API boundary in `hooks.settings-error-path.test.tsx`.
  it('requests BOTH invalidations when a narratorr write commits and then 500s', () => {
    cb(useUpdateConnectors()).onSettled(undefined, new ApiError(500, 'E', 'reconfigure blew up'), {
      narratorr: { url: 'http://n:3000', apiKey: 'k' },
    });
    expect(hoisted.qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: qk.connectors });
    expect(hoisted.qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: qk.features });
  });

  it('keeps the body-sensitive feature trigger on the error path too', () => {
    // A failed publicUrl save must not start refetching features either — the trigger is the
    // BODY, not the outcome.
    cb(useUpdateConnectors()).onSettled(undefined, new ApiError(500, 'E', 'boom'), { publicUrl: null });
    expect(hoisted.qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: qk.connectors });
    expect(hoisted.qc.invalidateQueries).not.toHaveBeenCalledWith({ queryKey: qk.features });
  });

  it('surfaces ApiError message, else "Save failed", on error', () => {
    const h = cb(useUpdateConnectors());
    h.onError(new ApiError(422, 'V', 'invalid url'));
    expect(error).toHaveBeenCalledWith('invalid url');
    h.onError(new Error('x'));
    expect(error).toHaveBeenCalledWith('Save failed');
  });
});

describe('useUpdateEbooksEnabled (#144)', () => {
  it('puts the built body on the wire unmodified, including an explicit false', async () => {
    const dto = { ebooksEnabled: false } as ConnectorSettingsDto;
    hoisted.api.updateConnectorSettings.mockResolvedValue(dto);

    await expect(mutFn(useUpdateEbooksEnabled())({ ebooksEnabled: false })).resolves.toBe(dto);
    expect(hoisted.api.updateConnectorSettings).toHaveBeenCalledWith({ ebooksEnabled: false });

    await mutFn(useUpdateEbooksEnabled())({ ebooksEnabled: true });
    expect(hoisted.api.updateConnectorSettings).toHaveBeenLastCalledWith({ ebooksEnabled: true });
  });

  it('invalidates connectors AND features — never setQueryData', () => {
    // The toggle is a SECOND per-card save on a page that already runs Public URL and quota saves
    // through `useUpdateConnectors`'s wholesale `setQueryData`. Adding another wholesale writer to
    // `qk.connectors` is the #160 rollback shape: under reverse settlement an earlier response
    // snapshot overwrites a later sibling's committed field, so the toggle visibly reverts even
    // though its own write succeeded. Invalidating re-reads the authoritative row instead.
    cb(useUpdateEbooksEnabled()).onSettled();
    expect(hoisted.qc.setQueryData).not.toHaveBeenCalled();
    expect(hoisted.qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: qk.connectors });
    // …and the derived payload is stale the moment the flag lands.
    expect(hoisted.qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: qk.features });
    cb(useUpdateEbooksEnabled()).onSuccess();
    expect(success).toHaveBeenCalledWith('Settings saved');
  });

  // F5 — the toggle write commits before the route's fallible reconfiguration tail, so an
  // errored save still has to refresh both keys or the admin sees the old gating for a flag
  // that is durably set.
  it('requests both invalidations when the toggle commits and then 500s', () => {
    cb(useUpdateEbooksEnabled()).onSettled(undefined, new ApiError(500, 'E', 'reconfigure blew up'));
    expect(hoisted.qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: qk.connectors });
    expect(hoisted.qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: qk.features });
  });

  it('neither the toggle nor its sibling ever blind-writes the shared connectors entry', () => {
    // This file mocks the QueryClient, so it can only prove which cache OPERATIONS are requested —
    // never what the cache converges on. That is the necessary condition; the sufficient one (the
    // final value after a reverse-order settle) is asserted against a REAL QueryClient in
    // `hooks.connector-cache.test.tsx`, which fails if either mutation reverts to setQueryData.
    cb(useUpdateEbooksEnabled()).onSettled();
    cb(useUpdateConnectors()).onSettled({} as ConnectorSettingsDto, null, {});
    expect(hoisted.qc.setQueryData).not.toHaveBeenCalled();
  });

  it('surfaces the ApiError message, else a fallback', () => {
    const h = cb(useUpdateEbooksEnabled());
    h.onError(new ApiError(400, 'BAD', 'nope'));
    expect(error).toHaveBeenCalledWith('nope');
    h.onError(new Error('x'));
    expect(error).toHaveBeenCalledWith('Save failed');
  });
});

describe('useUpdateKindleSender (#143)', () => {
  // The picker gets its OWN mutation rather than reusing useUpdateConnectors, and it INVALIDATES
  // the shared key instead of writing it wholesale — a second `setQueryData` writer behind a
  // second Save on the same page is the issue #160 shape. It also re-runs the server's read-time
  // resolution, which is what turns a reconfirm into `ok` on screen.
  // The picker's Save must actually reach the connectors PUT carrying the body it built —
  // driving only onSuccess/onError would leave `mutationFn` free to drop, rewrite, or route the
  // selection somewhere else with every test still green.
  it('puts the submitted body on the wire through updateConnectorSettings, unmodified', async () => {
    const dto = { publicUrl: null } as ConnectorSettingsDto;
    hoisted.api.updateConnectorSettings.mockResolvedValue(dto);
    const body: UpdateConnectorSettingsBody = { kindleSender: { notifierId: 'nf_1' } };

    await expect(mutFn(useUpdateKindleSender())(body)).resolves.toBe(dto);

    expect(hoisted.api.updateConnectorSettings).toHaveBeenCalledTimes(1);
    expect(hoisted.api.updateConnectorSettings).toHaveBeenCalledWith({ kindleSender: { notifierId: 'nf_1' } });
  });

  it('forwards a clear body verbatim too (null is a value, not an omission)', async () => {
    hoisted.api.updateConnectorSettings.mockResolvedValue({} as ConnectorSettingsDto);
    await mutFn(useUpdateKindleSender())({ kindleSender: null });
    expect(hoisted.api.updateConnectorSettings).toHaveBeenCalledWith({ kindleSender: null });
  });

  it('invalidates the connectors key (never setQueryData) and toasts "Kindle sender saved"', () => {
    cb(useUpdateKindleSender()).onSettled();
    expect(hoisted.qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: qk.connectors });
    expect(hoisted.qc.setQueryData).not.toHaveBeenCalled();
    cb(useUpdateKindleSender()).onSuccess();
    expect(success).toHaveBeenCalledWith('Kindle sender saved');
  });

  // F3 — `/api/features` derives `kindleSenderEmail` / `kindleDeliveryAvailable` from the SAME
  // read-time sender resolution this save changes, so the selection must retire both keys.
  it('also retires the derived feature query (selection changes Kindle readiness)', () => {
    cb(useUpdateKindleSender()).onSettled();
    expect(hoisted.qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: qk.features });
  });

  // F5 — the sender write commits before the fallible tail, so a 500 still has to reconcile.
  it('requests both invalidations when a sender selection commits and then 500s', () => {
    cb(useUpdateKindleSender()).onSettled(undefined, new ApiError(500, 'E', 'reconfigure blew up'));
    expect(hoisted.qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: qk.connectors });
    expect(hoisted.qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: qk.features });
  });

  it('surfaces the ApiError message (the case-specific KINDLE_SENDER_INVALID text), else a fallback', () => {
    const h = cb(useUpdateKindleSender());
    h.onError(new ApiError(400, 'KINDLE_SENDER_INVALID', 'The Kindle sender must be an email (SMTP) notifier.'));
    expect(error).toHaveBeenCalledWith('The Kindle sender must be an email (SMTP) notifier.');
    h.onError(new Error('x'));
    expect(error).toHaveBeenCalledWith('Could not save the Kindle sender');
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
    cb(useCreateNotifier()).onSettled();
    expect(hoisted.qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: qk.connectors });
    expect(hoisted.qc.setQueryData).not.toHaveBeenCalled();
    cb(useCreateNotifier()).onSuccess();
    expect(success).toHaveBeenCalledWith('Notifier added');
  });

  // F3 — the Kindle sender is resolved at READ time against the live notifier list, so editing
  // the selected notifier's `from` flips it to `sender-changed` and deleting it to
  // `notifier-missing`; both change the `/api/features` payload. CREATE is the one notifier
  // mutation that cannot: the resolver matches the stored selection by id, and a new notifier gets
  // a fresh `publicId('nf')` that no stored selection can already name.
  it('useCreateNotifier does NOT retire the feature query (a new id can never be the selected sender)', () => {
    cb(useCreateNotifier()).onSettled();
    expect(hoisted.qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: qk.connectors });
    expect(hoisted.qc.invalidateQueries).not.toHaveBeenCalledWith({ queryKey: qk.features });
  });

  // F6 sibling — create cannot change the SENDER, but its own write is just as durable-before-500
  // as the others, so the notifier list still has to reconcile on the error path.
  it('useCreateNotifier requests only the connectors invalidation when the create commits and then 500s', () => {
    cb(useCreateNotifier()).onSettled(undefined, new ApiError(500, 'E', 'reconfigure blew up'));
    expect(hoisted.qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: qk.connectors });
    expect(hoisted.qc.invalidateQueries).not.toHaveBeenCalledWith({ queryKey: qk.features });
  });

  it('useCreateNotifier surfaces ApiError message, else "Could not add notifier"', () => {
    const h = cb(useCreateNotifier());
    h.onError(new ApiError(400, 'B', 'bad notifier'));
    expect(error).toHaveBeenCalledWith('bad notifier');
    h.onError(new Error('x'));
    expect(error).toHaveBeenCalledWith('Could not add notifier');
  });

  it('useUpdateNotifier invalidates the connectors key and toasts "Notifier saved"', () => {
    cb(useUpdateNotifier()).onSettled();
    expect(hoisted.qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: qk.connectors });
    cb(useUpdateNotifier()).onSuccess();
    expect(success).toHaveBeenCalledWith('Notifier saved');
  });

  it('useUpdateNotifier retires the feature query (an edited `from` can break the saved sender)', () => {
    cb(useUpdateNotifier()).onSettled();
    expect(hoisted.qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: qk.features });
  });

  // F6 — notifier edit persists before the fallible tail, so a 500 must still
  // reconcile the Kindle-derived feature state.
  it('useUpdateNotifier requests both invalidations when the write commits and then 500s', () => {
    cb(useUpdateNotifier()).onSettled(undefined, new ApiError(500, 'E', 'reconfigure blew up'));
    expect(hoisted.qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: qk.connectors });
    expect(hoisted.qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: qk.features });
  });

  it('useUpdateNotifier surfaces ApiError message, else "Could not save notifier"', () => {
    const h = cb(useUpdateNotifier());
    h.onError(new ApiError(404, 'N', 'gone'));
    expect(error).toHaveBeenCalledWith('gone');
    h.onError(new Error('x'));
    expect(error).toHaveBeenCalledWith('Could not save notifier');
  });

  it('useDeleteNotifier invalidates the connectors key and toasts "Notifier deleted"', () => {
    cb(useDeleteNotifier()).onSettled();
    expect(hoisted.qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: qk.connectors });
    cb(useDeleteNotifier()).onSuccess();
    expect(success).toHaveBeenCalledWith('Notifier deleted');
  });

  it('useDeleteNotifier retires the feature query (deleting the selected sender ends delivery)', () => {
    cb(useDeleteNotifier()).onSettled();
    expect(hoisted.qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: qk.features });
  });

  // F6 — notifier delete persists before the fallible tail, so a 500 must still
  // reconcile the Kindle-derived feature state.
  it('useDeleteNotifier requests both invalidations when the write commits and then 500s', () => {
    cb(useDeleteNotifier()).onSettled(undefined, new ApiError(500, 'E', 'reconfigure blew up'));
    expect(hoisted.qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: qk.connectors });
    expect(hoisted.qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: qk.features });
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

describe('useSendToKindle — the send mutation (#149)', () => {
  // This mutation is the ONE that converges no cache: a send changes no cached resource, so the
  // right receipt here is exactly what the wholesale react-query mock can prove — which API call it
  // dispatches, that it asks for NO cache operation, and which toast each answer raises
  // (react-query-mock-hides-cache-convergence). It also OWNS the toasts: the sheet raises none, so
  // "exactly one toast per answer" is assertable here.
  const send = (bookId: string, title: string) =>
    mutFn<{ bookId: string; title: string }>(useSendToKindle())({ bookId, title });

  it('dispatches sendEbookToKindle with the book id and the sheet’s title', async () => {
    hoisted.api.sendEbookToKindle.mockResolvedValue({ outcome: 'sent' });

    await expect(send('bk_abc123', 'The Hobbit')).resolves.toEqual({ outcome: 'sent' });

    expect(hoisted.api.sendEbookToKindle).toHaveBeenCalledTimes(1);
    expect(hoisted.api.sendEbookToKindle).toHaveBeenCalledWith('bk_abc123', 'The Hobbit');
  });

  it('writes NO cache at all — no setQueryData, no invalidateQueries', () => {
    const hook = useSendToKindle() as { onSettled?: unknown };
    cb(useSendToKindle()).onSuccess({ outcome: 'sent' });
    cb(useSendToKindle()).onError(new ApiError(500, 'INTERNAL', 'boom'));
    // A send changes no cached resource: `me`, `features` and the request lists are all unaffected.
    expect(hoisted.qc.setQueryData).not.toHaveBeenCalled();
    expect(hoisted.qc.invalidateQueries).not.toHaveBeenCalled();
    // …and there is no settlement hook quietly reconciling either.
    expect(hook.onSettled).toBeUndefined();
  });

  it('raises exactly ONE success toast for `sent`', () => {
    cb(useSendToKindle()).onSuccess({ outcome: 'sent' });
    expect(success).toHaveBeenCalledTimes(1);
    expect(success).toHaveBeenCalledWith(sendOutcomeMessage('sent'));
    expect(error).not.toHaveBeenCalled();
  });

  it.each(EBOOK_SEND_OUTCOMES.filter((o) => o !== 'sent'))(
    'raises exactly ONE error toast for the %s outcome',
    (outcome) => {
      cb(useSendToKindle()).onSuccess({ outcome });
      expect(error).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith(sendOutcomeMessage(outcome));
      expect(success).not.toHaveBeenCalled();
    },
  );

  it('maps a REJECTED request through the error-code table, not the outcome table', () => {
    cb(useSendToKindle()).onError(new ApiError(403, 'EBOOKS_DISABLED', 'off'));
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(sendErrorMessage('EBOOKS_DISABLED'));
  });

  it('falls back to the generic copy for a non-ApiError rejection (a network failure)', () => {
    cb(useSendToKindle()).onError(new TypeError('network'));
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(GENERIC_SEND_ERROR);
  });
});
