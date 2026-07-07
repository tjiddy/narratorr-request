import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { V1AudibleResult } from '@shared/schemas/v1/metadata';
import type { RequestStatus } from '@shared/schemas/request';
import type { UpdateUserBody, UpdateMeBody } from '@shared/schemas/user';
import type {
  UpdateConnectorSettingsBody,
  TestConnectorBody,
  CreateNotifierBody,
  UpdateNotifierBody,
  NotifierTestBody,
} from '@shared/schemas/connectors';
import {
  getMe,
  updateMe,
  searchCatalog,
  listMyRequests,
  listAdminQueue,
  requestBookFrom,
  decideRequest,
  listUsers,
  updateUser,
  listUserRequests,
  getConnectorSettings,
  getSystemInfo,
  updateConnectorSettings,
  testConnector,
  createNotifier,
  updateNotifier,
  deleteNotifier,
  testNotifier,
  getAuthProviders,
  getPublicConfig,
  localLogin,
  localSignup,
  ApiError,
} from './api';
import { decideBadge } from './instance-badge';

export const qk = {
  me: ['me'] as const,
  search: (q: string) => ['search', q] as const,
  // The bare `['requests','mine']` key is the stable default-first-page variant Search
  // reads (and the invalidation prefix); the paged views key on their growing `limit`
  // under it, so invalidating the prefix still refreshes every loaded page.
  myRequests: ['requests', 'mine'] as const,
  myRequestsPaged: (limit: number) => ['requests', 'mine', 'paged', limit] as const,
  // The bare `['admin','requests']` prefix a decide-mutation invalidates; the queue
  // variants key their `status`/`limit` under it, so invalidating the prefix refetches
  // every loaded admin-queue page.
  adminRequests: ['admin', 'requests'] as const,
  adminQueue: (status?: RequestStatus) => ['admin', 'requests', status ?? 'all'] as const,
  adminQueuePaged: (status: RequestStatus | undefined, limit: number) =>
    ['admin', 'requests', status ?? 'all', limit] as const,
  // The bare `['admin','users']` prefix (user list + the per-user request lists nest
  // under it); an update invalidates the prefix so both refresh together.
  users: ['admin', 'users'] as const,
  userRequests: (publicId: string, limit: number) =>
    ['admin', 'users', publicId, 'requests', limit] as const,
  // The connectors settings blob — one entry shared by the query, its optimistic
  // setQueryData write, and the notifier mutations that invalidate it. These must agree
  // byte-for-byte or save → cache-write → invalidate silently no-ops.
  connectors: ['admin', 'settings', 'connectors'] as const,
  system: ['admin', 'system'] as const,
  authProviders: ['auth', 'providers'] as const,
};

// --- Paged-list placeholder scoping ------------------------------------------
// The paged request-list hooks key on a growing `limit` (the trailing key element).
// We want the previous page's rows to stay on-screen while a *larger* page of the SAME
// list loads (Load-more, and each poll at a stable limit) — but NOT to bleed across a
// filter or user switch, where the prior key differs in a non-limit segment and the
// stale rows would be mislabeled as the new list. A bare `keepPreviousData` retains the
// prior data on *every* key change, so a filter/user switch resolves to `success` with
// the wrong rows and `isLoading` never re-fires. These helpers scope the retention to
// the intended case.

/**
 * True when two query keys describe the same paged list at a (possibly) different limit:
 * equal length and identical in every element except the trailing `limit`. `false` on any
 * non-limit segment difference (filter/user switch) or a length mismatch.
 */
export const samePagedList = (a: readonly unknown[], b: readonly unknown[]): boolean =>
  a.length === b.length && a.slice(0, -1).every((v, i) => Object.is(v, b[i]));

/**
 * A `placeholderData` factory scoped to one paged list. Retains the previous query's data
 * only when that query is the same list (same filter / same user) at a different limit;
 * otherwise returns `undefined` so the query re-enters `pending` and the page's existing
 * `isLoading` "Loading…" branch renders instead of the prior filter/user's rows.
 *
 * TanStack v5's `PlaceholderDataFunction` receives `(previousData, previousQuery)` but not
 * the current key, so we close over it here. The returned function stays generic in the
 * data type so it satisfies each hook's `placeholderData` slot without a cast.
 */
export const keepSameListData =
  (currentKey: readonly unknown[]) =>
  <TData>(prev: TData | undefined, prevQuery?: { queryKey: readonly unknown[] }): TData | undefined =>
    prev !== undefined && prevQuery && samePagedList(prevQuery.queryKey, currentKey) ? prev : undefined;

export const useMe = () =>
  useQuery({ queryKey: qk.me, queryFn: getMe, retry: false, staleTime: 60_000 });

/** Save the caller's own requester-notification opt-in set (issue #50). Writes the fresh MeDto
 *  straight into the `me` cache so the control + nudge reflect the new set immediately. */
export function useUpdateMe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateMeBody) => updateMe(body),
    onSuccess: (dto) => {
      qc.setQueryData(qk.me, dto);
      toast.success('Notification preferences saved');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save preferences'),
  });
}

export const useSearch = (q: string) =>
  useQuery({
    queryKey: qk.search(q),
    queryFn: () => searchCatalog(q),
    enabled: q.trim().length > 0,
    staleTime: 60_000,
  });

/** The caller's default first page — the request set Search badges against. Kept bare
 *  (no limit/offset) so it reads exactly what it did before paging landed. */
export const useMyRequests = () =>
  useQuery({ queryKey: qk.myRequests, queryFn: () => listMyRequests(), refetchInterval: 4000 });

/** My Requests list view — a bounded growing-limit page, polled so `acquiring → available`
 *  transitions show up live. `keepSameListData` holds the loaded rows on-screen while a
 *  larger page of the same list fetches, so "Load more" (and each poll at a stable limit)
 *  never blanks the list. This key varies only by `limit`, so the scoping is a no-op here —
 *  it always retains — but sharing the helper keeps all three paged hooks consistent. */
export const useMyRequestsPaged = (limit: number) => {
  const key = qk.myRequestsPaged(limit);
  return useQuery({
    queryKey: key,
    queryFn: () => listMyRequests({ limit }),
    refetchInterval: 4000,
    placeholderData: keepSameListData(key),
  });
};

export const useAdminQueue = (status: RequestStatus | undefined, limit: number) => {
  const key = qk.adminQueuePaged(status, limit);
  return useQuery({
    queryKey: key,
    queryFn: () => listAdminQueue(status, { limit }),
    refetchInterval: 5000,
    // Retain rows only while a larger page of the *same* status loads — a filter switch
    // (non-limit segment change) drops the placeholder so "Loading…" shows, never the
    // previous filter's rows.
    placeholderData: keepSameListData(key),
  });
};

export function useRequestBook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (result: V1AudibleResult) => requestBookFrom(result),
    onSuccess: (req) => {
      toast.success(req.status === 'available' ? `“${req.title}” is already available!` : `Requested “${req.title}”`);
      void qc.invalidateQueries({ queryKey: qk.myRequests });
      void qc.invalidateQueries({ queryKey: qk.me });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Request failed'),
  });
}

export const useUsers = () =>
  useQuery({ queryKey: qk.users, queryFn: listUsers });

export const useUserRequests = (publicId: string, limit: number) => {
  const key = qk.userRequests(publicId, limit);
  return useQuery({
    queryKey: key,
    queryFn: () => listUserRequests(publicId, { limit }),
    // Retain rows only while a larger page of the *same* user loads — navigating to a
    // different user (non-limit segment change) drops the placeholder so "Loading…" shows,
    // never the previous user's requests.
    placeholderData: keepSameListData(key),
  });
};

export function useUpdateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { publicId: string; patch: UpdateUserBody }) => updateUser(v.publicId, v.patch),
    onSuccess: (user) => {
      toast.success(`Saved changes to ${user.username}`);
      void qc.invalidateQueries({ queryKey: qk.users });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Failed to update user'),
  });
}

export function useDecide() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { publicId: string; action: 'approve' | 'deny'; note?: string }) =>
      decideRequest(v.publicId, v.action, v.note),
    onSuccess: (req, v) => {
      toast.success(v.action === 'approve' ? `Approved “${req.title}”` : `Denied “${req.title}”`);
      void qc.invalidateQueries({ queryKey: qk.adminRequests });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Action failed'),
  });
}

// --- System information (admin) ----------------------------------------------
export const useSystemInfo = () =>
  // Read-only diagnostics; refetch on a slow interval so narratorr reachability stays
  // roughly live without hammering the upstream probe.
  useQuery({ queryKey: qk.system, queryFn: getSystemInfo, refetchInterval: 30_000 });

// --- Connector settings (admin) ----------------------------------------------
export const useConnectorSettings = () =>
  // No refetch-on-focus: the Settings form remounts on cache change, so a background
  // refetch would discard in-progress edits.
  useQuery({
    queryKey: qk.connectors,
    queryFn: getConnectorSettings,
    refetchOnWindowFocus: false,
  });

export function useUpdateConnectors() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateConnectorSettingsBody) => updateConnectorSettings(body),
    onSuccess: (dto) => {
      qc.setQueryData(qk.connectors, dto);
      toast.success('Settings saved');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Save failed'),
  });
}

export function useTestConnector() {
  return useMutation({
    mutationFn: (body: TestConnectorBody) => testConnector(body),
    onSuccess: (res) => (res.success ? toast.success(res.message) : toast.error(res.message)),
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Test failed'),
  });
}

// --- Notifiers (admin) -------------------------------------------------------
// Mutations refetch the connector settings (which carries the notifier list) so the
// list reflects the committed state — and the masked secrets reset cleanly. They
// invalidate `qk.connectors`, the same entry the connectors query reads and the save
// writes, so all four sites agree through one registry entry.

export function useCreateNotifier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateNotifierBody) => createNotifier(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.connectors });
      toast.success('Notifier added');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not add notifier'),
  });
}

export function useUpdateNotifier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateNotifierBody }) => updateNotifier(id, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.connectors });
      toast.success('Notifier saved');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save notifier'),
  });
}

export function useDeleteNotifier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteNotifier(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.connectors });
      toast.success('Notifier deleted');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not delete notifier'),
  });
}

export function useTestNotifier() {
  return useMutation({
    mutationFn: (body: NotifierTestBody) => testNotifier(body),
    onSuccess: (res) => (res.success ? toast.success(res.message) : toast.error(res.message)),
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Test failed'),
  });
}

// --- Auth: login screen + local auth -----------------------------------------
// Drives the server-rendered login screen. Static for the session (provider config
// only changes via env + restart), so no refetch-on-focus.
export const useAuthProviders = () =>
  useQuery({ queryKey: qk.authProviders, queryFn: getAuthProviders, staleTime: Infinity, retry: false });

/** Local signup/login. On success the server set a session cookie — refetch `me` so
 *  App routes to the app (or the pending screen). Errors surface on the form, not a toast. */
export function useLocalAuth(mode: 'login' | 'signup') {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { email: string; password: string }) =>
      (mode === 'login' ? localLogin : localSignup)(v.email, v.password),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.me }),
  });
}

// --- Theme (light/dark) -------------------------------------------------------
// Ported from Narratorr (hooks/useTheme.ts). Source of truth is localStorage
// 'theme'; the no-flash <script> in index.html applies it before first paint, and
// this hook keeps the `.dark` class on <html> in sync once React mounts.
type Theme = 'light' | 'dark';

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('theme') as Theme | null;
      if (stored) return stored;
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return 'light';
  });

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') root.classList.add('dark');
    else root.classList.remove('dark');
    localStorage.setItem('theme', theme);
  }, [theme]);

  const toggleTheme = () => setTheme((prev) => (prev === 'light' ? 'dark' : 'light'));

  return { theme, toggleTheme };
}

// --- Instance badge (dev-vs-prod tab distinguisher, issue #135) ----------------
// Thin DOM shim over the pure `decideBadge()` decision (untested by convention — the logic it wraps
// is unit-tested in instance-badge.test.ts). Mounted once at the top of App() before its auth/loading
// branches so it runs for BOTH authenticated and unauthenticated tabs. Fetches the public config and,
// when a badge is set, prefixes the tab title and swaps the favicon to the violet-recolored data URI.
// Unset (prod) is a pure no-op: the decision returns identity, so the DOM is never touched (no flash).
// A failed fetch just leaves the baseline tab — display-only, never surfaces an error into the UI.
export function useInstanceBadge(): void {
  useEffect(() => {
    let cancelled = false;
    void getPublicConfig()
      .then((cfg) => {
        if (cancelled) return;
        const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
        const current = {
          title: document.title,
          faviconHref: link?.getAttribute('href') ?? '/favicon.svg',
        };
        const next = decideBadge(cfg.instanceBadge, current);
        if (next.title !== current.title) document.title = next.title;
        if (link && next.faviconHref !== current.faviconHref) link.setAttribute('href', next.faviconHref);
      })
      .catch(() => {
        // Display-only; a failed /api/config leaves the baseline favicon + title. Never throws into the UI.
      });
    return () => {
      cancelled = true;
    };
  }, []);
}
