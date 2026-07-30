import { describe, it, expect } from 'vitest';
import { ApiError } from './api';
import { resolveMeShell, type MeShell } from './app-shell';

/**
 * The `me` shell policy (#168 AC6) as a pure table — the modality this decision belongs in
 * (frontend-logic-extract-not-jsdom): it is a four-way decision over three inputs, not DOM behavior.
 * That `App` actually DELEGATES to it is a separate, wiring-shaped claim, asserted in `App.test.tsx`.
 *
 * The rows that changed are 6 and 8: a failed refetch that RETAINED data keeps the session alive.
 * That state became routinely reachable when the mutation hooks moved their `qk.me` reconciliation to
 * `onSettled` — a failed `PATCH /api/me` now issues a `GET /api/me`, and both go through the same
 * `buildMeDto()` tail, so the read can fail on exactly what the write failed on. With `retry: false`
 * that lands as `error` + retained `data`.
 */

/** A retained `me` payload — only its PRESENCE is what the decision turns on. */
const data = { publicId: 'us_1' };

describe('resolveMeShell — the App shell decision for the me query (#168 AC6)', () => {
  it.each<[number, { isLoading: boolean; error: unknown; data: unknown }, MeShell, string]>([
    [1, { isLoading: true, error: null, data: undefined }, 'loading', 'first load has not settled'],
    [2, { isLoading: false, error: null, data }, 'app', 'the ordinary signed-in case'],
    [3, { isLoading: false, error: new ApiError(401, 'UNAUTHORIZED', 'no session'), data: undefined }, 'login', 'never signed in'],
    // The guard row: an EXPIRED session must never keep the shell alive on a stale payload, so the
    // 401 test has to outrank the retained-data test.
    [4, { isLoading: false, error: new ApiError(401, 'UNAUTHORIZED', 'session expired'), data }, 'login', '401 outranks retained data'],
    [5, { isLoading: false, error: new ApiError(500, 'BOOM', 'quota lookup blew up'), data: undefined }, 'fatal', 'cannot enter the app at all'],
    // CHANGED (#168): previously a full-screen error, which threw away a working session because a
    // background/reconciliation refetch failed.
    [6, { isLoading: false, error: new ApiError(500, 'BOOM', 'quota lookup blew up'), data }, 'app', 'keep the last-known me'],
    [7, { isLoading: false, error: new TypeError('Failed to fetch'), data: undefined }, 'login', 'network failure, nothing to render'],
    // CHANGED (#168): previously bounced a signed-in user to the login screen on a transient blip.
    [8, { isLoading: false, error: new TypeError('Failed to fetch'), data }, 'app', 'a network blip is not a logout'],
  ])('state %i → %s (%s)', (_n, state, expected) => {
    expect(resolveMeShell(state)).toBe(expected);
  });

  it('prefers loading over everything else while the first load is in flight', () => {
    // `isLoading` is only true with no data, but pin the precedence anyway: a placeholder/retained
    // payload arriving alongside it must not skip the splash.
    expect(resolveMeShell({ isLoading: true, error: new ApiError(500, 'B', 'x'), data })).toBe('loading');
  });

  it('routes a data-less, error-less settle to the login screen (unchanged fallback)', () => {
    expect(resolveMeShell({ isLoading: false, error: null, data: undefined })).toBe('login');
  });

  it('treats a non-ApiError with no data as login, never fatal — the full-screen error is for API failures', () => {
    // A raw `Error` carries no status, so it cannot be classified as a non-401 API failure; the old
    // inline branch made exactly this distinction and it is preserved.
    expect(resolveMeShell({ isLoading: false, error: new Error('boom'), data: undefined })).toBe('login');
  });
});
