import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ErrorInfo } from 'react';
import { ErrorBoundary } from './ErrorBoundary';

/**
 * Node-only coverage for the class's lifecycle *wiring* — the seam between React's
 * lifecycle hooks and the pure `error-boundary-state` helpers. The helper unit tests
 * (`error-boundary-state.test.ts`) would all stay green if the class stopped delegating,
 * so these assert the delegation itself. No render / jsdom: we call the static method and
 * instance methods directly.
 */
describe('ErrorBoundary class seam', () => {
  afterEach(() => vi.restoreAllMocks());

  it('starts from the recovered (non-errored) state, seeding prevResetKey from the current key', () => {
    const boundary = new ErrorBoundary({ children: null, resetKey: '/start' });
    expect(boundary.state).toEqual({ hasError: false, prevResetKey: '/start' });
  });

  it('getDerivedStateFromError delegates the thrown value into the errored state', () => {
    const error = new Error('boom');
    expect(ErrorBoundary.getDerivedStateFromError(error)).toEqual({ hasError: true, error });
    // non-Error throws flow through the same seam
    expect(ErrorBoundary.getDerivedStateFromError('kaboom')).toEqual({ hasError: true, error: 'kaboom' });
  });

  it('getDerivedStateFromProps delegates to the pure reset reducer', () => {
    const errored = { hasError: true as const, error: new Error('boom'), prevResetKey: '/a' };
    // key changed while errored → recover
    expect(
      ErrorBoundary.getDerivedStateFromProps({ children: null, resetKey: '/b' }, errored),
    ).toEqual({ hasError: false, prevResetKey: '/b' });
    // same key → no-clobber of the freshly-caught error
    expect(
      ErrorBoundary.getDerivedStateFromProps({ children: null, resetKey: '/a' }, errored),
    ).toBeNull();
  });

  it('componentDidCatch surfaces the error and component stack via console.error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const boundary = new ErrorBoundary({ children: null, resetKey: '/' });
    const error = new Error('boom');
    const info: ErrorInfo = { componentStack: 'at SearchPage' };

    boundary.componentDidCatch(error, info);

    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]).toContain(error);
    expect(spy.mock.calls[0]).toContain('at SearchPage');
  });
});
