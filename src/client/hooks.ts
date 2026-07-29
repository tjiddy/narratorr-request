import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { V1AudibleResult } from '@shared/schemas/v1/metadata';
import type { RequestStatus } from '@shared/schemas/request';
import type { MeDto, UpdateUserBody, UpdateMeBody } from '@shared/schemas/user';
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
  getFeatures,
  sendEbookToKindle,
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
import { featuresQueryEnabled } from './features';
import { meSuccessToast, mergeMeCache } from './pages/notify-prefs';
import { sendOutcomeMessage, sendErrorMessage } from './components/ebook-sheet';

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
  // The connectors settings blob — one entry shared by the query and by every settings/notifier
  // mutation, all of which INVALIDATE it (no writer holds a wholesale setQueryData any more; see
  // `reconcileConnectorWrite`). These must agree byte-for-byte or an invalidation silently no-ops.
  connectors: ['admin', 'settings', 'connectors'] as const,
  system: ['admin', 'system'] as const,
  // Derived feature state (issue #144). Instance-level and identical for every active caller, so
  // one un-parameterized entry — no per-user segment.
  features: ['features'] as const,
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

/** The account modal's self-scoped save (issue #131). Backs three callers — the explicit contact-email
 *  Save, the explicit Kindle-address Save (#142), and the instant-apply notification checkboxes — each
 *  PATCHing `/api/me` through its OWN instance, so two saves can be in flight at once. Folds the fresh
 *  MeDto into the `me` cache so the control reflects the new state immediately, via `mergeMeCache`:
 *  a response is authoritative only for the fields its own body wrote, so an earlier request settling
 *  last can't roll back a newer sibling save (#142 F1). Still a direct cache write, not an
 *  invalidate — no refetch round-trip. Success feedback is proportional to the payload via
 *  `meSuccessToast` (#134): an address save acknowledges, a notifyOn-only toggle is silent (the
 *  persisted checkbox is the confirmation). Errors always toast. */
export function useUpdateMe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateMeBody) => updateMe(body),
    onSuccess: (dto, body) => {
      qc.setQueryData<MeDto>(qk.me, (prev) => mergeMeCache(prev, dto, body));
      const message = meSuccessToast(body);
      if (message) toast.success(message);
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

// --- Derived feature state (issue #144) --------------------------------------
/**
 * Instance-level feature flags for the signed-in SPA. Gated on an ACTIVE caller: `/api/features`
 * is `requireActiveUser`, so firing it on the login or pending/rejected screen would only produce
 * a 401/403 and an error state the gate then has to fail-safe around. Pass the `me` payload
 * (`useMe().data`); `undefined` keeps the query disabled.
 *
 * Read the result through the pure gates in `./features` (`ebooksVisible` /
 * `kindleDeliveryVisible`) rather than touching `.data` directly — they own the fail-safe
 * loading/error handling.
 */
export const useFeatures = (me: MeDto | undefined) =>
  useQuery({
    queryKey: qk.features,
    queryFn: getFeatures,
    enabled: featuresQueryEnabled(me),
    // Operator config changes rarely, and the server already caches the capability probe — but
    // don't hold a disabled-to-enabled flip for a whole session either.
    staleTime: 60_000,
  });

// --- Send to Kindle (issue #149) ---------------------------------------------
/**
 * Send one companion eBook to the caller's own Kindle. The ONE mutation in this module that
 * touches NO cache: a send changes no cached resource — not `me` (the address is unchanged), not
 * `features` (operator config is unchanged), not the request lists — so there is nothing to
 * invalidate and nothing to write. Adding a refetch here would only cost a round-trip.
 *
 * TOAST OWNERSHIP LIVES HERE, and only here. The sheet raises none, so every answer produces
 * exactly one notification rather than a duplicate pair:
 *   • a RESOLVED `{ outcome }` is not yet a success — every admitted attempt answers 200, failures
 *     included, so the outcome (not the status code) picks the channel and the copy.
 *   • a REJECTED request is a different thing entirely and maps through its own code table.
 */
export function useSendToKindle() {
  return useMutation({
    mutationFn: (v: { bookId: string; title: string }) => sendEbookToKindle(v.bookId, v.title),
    onSuccess: (result) => {
      const message = sendOutcomeMessage(result.outcome);
      if (result.outcome === 'sent') toast.success(message);
      else toast.error(message);
    },
    onError: (err) => toast.error(sendErrorMessage(err instanceof ApiError ? err.code : '')),
  });
}

// --- Connector settings (admin) ----------------------------------------------
export const useConnectorSettings = () =>
  // No refetch-on-focus: the Settings form remounts on cache change, so a background
  // refetch would discard in-progress edits.
  useQuery({
    queryKey: qk.connectors,
    queryFn: getConnectorSettings,
    refetchOnWindowFocus: false,
  });

/**
 * Reconcile the caches a settings write can invalidate, from the SERVER's committed state.
 *
 * Called from `onSettled`, never `onSuccess`. Every settings route persists FIRST and only then
 * awaits the fallible reconfiguration tail (`routes/settings.ts` — `update()`/`createNotifier()`/
 * `updateNotifier()`/`deleteNotifier()` all commit before `await reconfigure(...)`), so a write can
 * be durable in the database and STILL answer 500. `settings.route.test.ts`'s rejecting-tail rows
 * assert exactly that pairing. Reconciling only on success therefore leaves the SPA rendering
 * pre-write state for a change that actually landed — the mirror image of the #160 race, and the
 * reason reconciliation is a settlement concern rather than a success concern.
 *
 * Refetching after a genuine failure (a 400 the server rejected outright, or an unsent request) is
 * the cheap direction: it costs one GET that returns the unchanged row. Guessing from the status
 * code which failures committed is not something a client can do correctly.
 *
 * `retiresCapability` mirrors the server's own trigger — `reconfigure(narratorrChanged)` bumps the
 * capability generation only for a narratorr write, so only that write needs `qk.features` on this
 * path. (Writes whose OWN field feeds the derived payload pass `true` unconditionally.)
 */
function reconcileConnectorWrite(qc: ReturnType<typeof useQueryClient>, retiresCapability: boolean): void {
  void qc.invalidateQueries({ queryKey: qk.connectors });
  if (retiresCapability) void qc.invalidateQueries({ queryKey: qk.features });
}

/**
 * The General + Narratorr cards' save. INVALIDATES `qk.connectors` rather than writing the
 * response DTO wholesale.
 *
 * It used to `setQueryData(qk.connectors, dto)`, which was safe only while exactly one mutation
 * instance existed. It hasn't been for a while: Public URL, default quota and Narratorr each
 * instantiate their own, and the ebook toggle (#144) added a fourth save to the same key. Two
 * concurrent saves are then a lost-update race — the server computes each response from the row as
 * it stood when THAT request read it, so a response that settles last overwrites the whole cache
 * entry with a snapshot predating its sibling's committed write (the #160 shape). Invalidating
 * instead means every save converges on one authoritative re-read regardless of settle order:
 * a later invalidation supersedes an in-flight refetch rather than racing a blind write against it.
 *
 * `qk.features` is retired only for a NARRATORR write — the same trigger, and the same reasoning,
 * as `reconfigure(narratorrChanged)` on the server (`routes/settings.ts`): swapping the connection
 * retires the cached capability generation, so an already-mounted `useFeatures` would otherwise
 * keep serving the previous server's `ebooksEnabled` until its `staleTime` lapsed AND something
 * happened to trigger a refetch (a stale mark alone schedules nothing). Public URL and quota saves
 * cannot change the derived payload, so they don't pay for a refetch.
 *
 * Both reconciliations run from `onSettled` — see {@link reconcileConnectorWrite} for why a 500 is
 * not evidence that nothing was written.
 */
export function useUpdateConnectors() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateConnectorSettingsBody) => updateConnectorSettings(body),
    onSettled: (_dto, _err, body) => reconcileConnectorWrite(qc, body.narratorr !== undefined),
    onSuccess: () => toast.success('Settings saved'),
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Save failed'),
  });
}

/**
 * The Kindle-sender picker's own save (issue #143). It hits the SAME connectors PUT but
 * INVALIDATES `qk.connectors` rather than writing it wholesale, mirroring the notifier-CRUD
 * mutations it sits beside — every save against this shared key now invalidates, which is what
 * makes concurrent saves converge instead of racing (#160). Invalidating also re-runs the
 * server's read-time resolution, which is what turns a reconfirm into `ok` on screen.
 */
export function useUpdateKindleSender() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateConnectorSettingsBody) => updateConnectorSettings(body),
    // `/api/features` derives `kindleSenderEmail` / `kindleDeliveryAvailable` from exactly the
    // read-time sender resolution this save changes (#144), so it always retires that key too.
    onSettled: () => reconcileConnectorWrite(qc, true),
    onSuccess: () => toast.success('Kindle sender saved'),
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save the Kindle sender'),
  });
}

/**
 * The companion-ebook toggle's own save (issue #144). Like {@link useUpdateKindleSender} it hits
 * the shared connectors PUT but INVALIDATES `qk.connectors` rather than writing it wholesale, so
 * concurrent saves converge on the server's authoritative row regardless of settle order (#160 —
 * asserted end-to-end in `hooks.connector-cache.test.tsx`).
 *
 * It always retires `qk.features` as well: this flag IS half of the derived `ebooksEnabled`, so
 * the payload is stale the moment the toggle lands, and an admin's own tab would otherwise keep
 * the old gating until something else happened to trigger a refetch. Reconciled on settlement, so
 * a toggle that commits and then 500s in the reconfiguration tail still refreshes the UI.
 */
export function useUpdateEbooksEnabled() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateConnectorSettingsBody) => updateConnectorSettings(body),
    onSettled: () => reconcileConnectorWrite(qc, true),
    onSuccess: () => toast.success('Settings saved'),
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
//
// EDIT and DELETE also retire `qk.features` (#144): the Kindle sender is resolved at READ time
// against the live notifier list, so editing the selected notifier's `from` flips it to
// `sender-changed` and deleting it to `notifier-missing` — both of which change
// `kindleDeliveryAvailable` / `kindleSenderEmail` on `/api/features`.
//
// CREATE deliberately does NOT: the resolver matches the stored selection by notifier id, and a
// new notifier is assigned a fresh `publicId('nf')`, so it cannot become (or repair) the selected
// sender. Adding one is the single notifier mutation that cannot change the derived payload.

export function useCreateNotifier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateNotifierBody) => createNotifier(body),
    onSettled: () => reconcileConnectorWrite(qc, false),
    onSuccess: () => toast.success('Notifier added'),
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not add notifier'),
  });
}

export function useUpdateNotifier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateNotifierBody }) => updateNotifier(id, body),
    onSettled: () => reconcileConnectorWrite(qc, true),
    onSuccess: () => toast.success('Notifier saved'),
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save notifier'),
  });
}

export function useDeleteNotifier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteNotifier(id),
    onSettled: () => reconcileConnectorWrite(qc, true),
    onSuccess: () => toast.success('Notifier deleted'),
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
