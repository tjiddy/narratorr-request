/**
 * Pure logic for the route-level {@link ErrorBoundary}. Kept as plain functions (not
 * baked into the class) so the state transitions are unit-tested directly in the node
 * project instead of being inferred from a jsdom render — see the
 * `frontend-logic-extract-not-jsdom` learning and the co-located `book-card-state` /
 * `status` helpers.
 */

/** Errored → carries the thrown value; recovered → no error. */
export type ErrorBoundaryState = { hasError: false } | { hasError: true; error: unknown };

/**
 * The boundary's full class state: the error union plus the last resetKey it observed.
 * `prevResetKey` is what lets `getDerivedStateFromProps` tell a real navigation (key
 * changed → recover) from an ordinary re-render on the same route (key equal → leave
 * a freshly-caught error alone). See {@link deriveResetState}.
 */
export type BoundaryState = ErrorBoundaryState & { prevResetKey: string };

/** The boundary's initial / reset state (a pure reset helper, testable + reusable). */
export function resetErrorState(): ErrorBoundaryState {
  return { hasError: false };
}

/**
 * The `getDerivedStateFromProps` reducer for navigation-driven reset. It runs on **every**
 * render — including the one right after `getDerivedStateFromError` — so it resets **only**
 * when the resetKey actually changed. An equal key must never clobber a freshly-caught error
 * on the same route (the no-clobber path); that is why we compare against the stored
 * `prevResetKey` rather than reacting to `hasError` alone. Returns the state patch to merge,
 * or `null` for no change.
 *
 * - key changed while errored → recover (clear the error) and advance `prevResetKey`.
 * - key unchanged            → `null` (no-clobber; covers the same-route re-render).
 * - key changed while healthy → just advance `prevResetKey` (no spurious state churn).
 */
export function deriveResetState(
  nextResetKey: string,
  state: BoundaryState,
): Partial<BoundaryState> | null {
  if (nextResetKey === state.prevResetKey) return null;
  if (state.hasError) return { ...resetErrorState(), prevResetKey: nextResetKey };
  return { prevResetKey: nextResetKey };
}

/**
 * The `getDerivedStateFromError` reducer: a pure function of the thrown value → next
 * state. Any value can be thrown in JS (not just `Error`), so `error` is `unknown` and
 * gets normalized for display by {@link errorMessage}.
 */
export function deriveErrorState(error: unknown): ErrorBoundaryState {
  return { hasError: true, error };
}

/**
 * A human-displayable message for any thrown value. Guards the non-`Error` cases (a bare
 * string, an object with no `.message`, `null`/`undefined`) so the fallback never crashes
 * reaching for `.message`.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim() !== '') return error;
  return 'Something went wrong while rendering this page.';
}

/**
 * Surface the thrown error for diagnosis (AC4) — a single seam over `console.error` so the
 * logging path is verifiable in node without a DOM render. Called from `componentDidCatch`.
 */
export function logBoundaryError(error: unknown, componentStack?: string | null): void {
  console.error('[ErrorBoundary] Uncaught render error:', error, componentStack ?? '');
}
