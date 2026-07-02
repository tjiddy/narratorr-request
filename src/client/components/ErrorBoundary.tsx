import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { Button } from './Button';
import { RefreshIcon } from './icons';
import {
  deriveErrorState,
  deriveResetState,
  resetErrorState,
  errorMessage,
  logBoundaryError,
  type ErrorBoundaryState,
  type BoundaryState,
} from './error-boundary-state';

type ErrorBoundaryProps = { children: ReactNode; resetKey: string };

/**
 * Route-level React error boundary. `App.tsx` uses the JSX `<BrowserRouter><Routes>` idiom
 * (not a data router), so React Router's `errorElement` isn't available here — this is a
 * hand-rolled class boundary (no new dependency). It wraps only the `<Outlet />` inside
 * `Layout`'s `<main>`, so a caught render throw leaves the header (nav / theme / sign-out)
 * fully interactive while the page content is replaced by a recoverable fallback card.
 *
 * Because `Layout` is the persistent layout-route element, this instance (and its state)
 * survives child-route navigation — so the boundary must reset itself, or a single caught
 * error would leave the stale fallback on every healthy route the user then clicks to. That
 * reset is driven by `resetKey` (the current pathname): `getDerivedStateFromProps` clears the
 * error whenever the key changes. All decision logic lives in the pure, node-tested
 * `error-boundary-state` helpers.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, BoundaryState> {
  // Seed `prevResetKey` to the current key so a same-route error is not self-cleared on the
  // very next render (getDerivedStateFromProps runs right after getDerivedStateFromError).
  state: BoundaryState = { ...resetErrorState(), prevResetKey: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return deriveErrorState(error);
  }

  static getDerivedStateFromProps(
    props: ErrorBoundaryProps,
    state: BoundaryState,
  ): Partial<BoundaryState> | null {
    return deriveResetState(props.resetKey, state);
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    logBoundaryError(error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return <ErrorFallback message={errorMessage(this.state.error)} />;
    }
    return this.props.children;
  }
}

/** Recoverable fallback card, mirroring the glass-card convention of `AccountStatusScreen`. */
function ErrorFallback({ message }: { message: string }) {
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center px-4">
      <div className="glass-card w-full max-w-sm rounded-2xl p-8 text-center">
        <h1 className="font-display text-xl font-semibold tracking-tight">Something went wrong</h1>
        <p className="mt-3 text-sm text-muted-foreground">{message}</p>
        <div className="mt-6 flex justify-center">
          <Button variant="primary" size="sm" icon={RefreshIcon} onClick={() => window.location.reload()}>
            Reload page
          </Button>
        </div>
      </div>
    </div>
  );
}
