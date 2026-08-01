import { ApiError } from './api';

/**
 * Which top-level shell `App` renders for the current `me` query state.
 *   • `loading` — the first load hasn't settled; render the splash.
 *   • `login`   — no usable session; render `LoginPage`.
 *   • `fatal`   — the app can't be entered and the failure isn't an auth failure; render the error.
 *   • `app`     — render the routed, signed-in application from `me.data`.
 */
export type MeShell = 'loading' | 'login' | 'fatal' | 'app';

/**
 * The `me` query's shell decision, extracted from `App` so the policy is a pure, table-tested
 * function rather than an inline branch (issue #168 AC6).
 *
 * The rule that made this worth extracting: **a failed REFETCH that retained data must not tear down
 * a working session.** The mutation hooks now reconcile `qk.me` from `onSettled`, so a failed save
 * issues a `GET /api/me` — and PATCH and GET share `buildMeDto()` (`routes/auth.ts`), so the read can
 * hit the very tail that just failed. `useMe` has `retry: false`, so that lands on the observer as
 * `error` with the previous `data` still retained. The old `me.error || !me.data` guard replaced a
 * perfectly good signed-in session with a full-screen error in exactly that case; it also bounced a
 * signed-in user to the login screen on any transient network blip during a background refetch.
 *
 * The full policy, exhaustive over (`isLoading`, error kind, data presence):
 *
 * | # | isLoading | error            | data     | shell   |
 * |---|-----------|------------------|----------|---------|
 * | 1 | true      | —                | absent   | loading |
 * | 2 | false     | none             | present  | app     |
 * | 3 | false     | ApiError 401     | absent   | login   |
 * | 4 | false     | ApiError 401     | retained | login   |
 * | 5 | false     | ApiError non-401 | absent   | fatal   |
 * | 6 | false     | ApiError non-401 | retained | app     |
 * | 7 | false     | non-ApiError     | absent   | login   |
 * | 8 | false     | non-ApiError     | retained | app     |
 *
 * Row 4 is why the 401 test comes FIRST: an expired session must never keep the shell alive on stale
 * data, so 401 outranks retention. Rows 6 and 8 are the change — keep rendering the last-known `me`.
 * No banner, badge or retry affordance is introduced for them: the failing mutation's own toast or
 * inline error is the user-facing signal, and the next successful refetch repairs the shell silently.
 */
export function resolveMeShell(me: { isLoading: boolean; error: unknown; data: unknown }): MeShell {
  if (me.isLoading) return 'loading';
  // An expired/absent session outranks retained data — otherwise a logged-out tab would keep
  // rendering the app off a stale `me` until something else cleared the cache.
  if (me.error instanceof ApiError && me.error.status === 401) return 'login';
  // Anything else with a usable payload keeps the session: a refetch failure (contract, 5xx, or a
  // network blip) is not a reason to throw away a working shell.
  if (me.data !== undefined) return 'app';
  if (me.error instanceof ApiError) return 'fatal';
  // No data and no API-shaped error: never signed in, or the request never reached the server.
  return 'login';
}
