import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  deriveErrorState,
  deriveResetState,
  resetErrorState,
  errorMessage,
  logBoundaryError,
} from './error-boundary-state';

describe('deriveErrorState', () => {
  it('carries a thrown Error into the errored state', () => {
    const error = new Error('boom');
    expect(deriveErrorState(error)).toEqual({ hasError: true, error });
  });

  it('carries a non-Error thrown value (string / object) into the errored state', () => {
    expect(deriveErrorState('kaboom')).toEqual({ hasError: true, error: 'kaboom' });
    const obj = { code: 42 };
    expect(deriveErrorState(obj)).toEqual({ hasError: true, error: obj });
  });
});

describe('resetErrorState', () => {
  it('returns a non-errored state (the recover / initial path)', () => {
    expect(resetErrorState()).toEqual({ hasError: false });
  });
});

describe('deriveResetState', () => {
  it('recovers when the resetKey changes while errored, advancing prevResetKey', () => {
    const errored = { hasError: true as const, error: new Error('boom'), prevResetKey: '/a' };
    expect(deriveResetState('/b', errored)).toEqual({ hasError: false, prevResetKey: '/b' });
  });

  it('leaves a freshly-caught error alone when the resetKey is unchanged (no-clobber)', () => {
    // getDerivedStateFromProps runs on the render right after getDerivedStateFromError, on the
    // same route — it must NOT clear the error the boundary just caught.
    const errored = { hasError: true as const, error: new Error('boom'), prevResetKey: '/a' };
    expect(deriveResetState('/a', errored)).toBeNull();
  });

  it('only tracks the new key (no spurious state change) when the resetKey changes while healthy', () => {
    const healthy = { hasError: false as const, prevResetKey: '/a' };
    expect(deriveResetState('/b', healthy)).toEqual({ prevResetKey: '/b' });
  });

  it('is a no-op when a healthy boundary re-renders on the same key', () => {
    const healthy = { hasError: false as const, prevResetKey: '/a' };
    expect(deriveResetState('/a', healthy)).toBeNull();
  });

  it('does not self-reset on first observation (prevResetKey seeded to the current key)', () => {
    // First render after an error on the initial route: the seeded prevResetKey equals the
    // current key, so the reset reducer is a no-op and the error survives.
    const errored = { hasError: true as const, error: new Error('boom'), prevResetKey: '/start' };
    expect(deriveResetState('/start', errored)).toBeNull();
  });
});

describe('errorMessage', () => {
  it('uses an Error’s own message', () => {
    expect(errorMessage(new Error('specific failure'))).toBe('specific failure');
  });

  it('falls back for a non-Error value without crashing on .message', () => {
    expect(errorMessage({ not: 'an error' })).toBe('Something went wrong while rendering this page.');
    expect(errorMessage(undefined)).toBe('Something went wrong while rendering this page.');
    expect(errorMessage(null)).toBe('Something went wrong while rendering this page.');
  });

  it('uses a non-empty thrown string, but falls back for an empty / whitespace one', () => {
    expect(errorMessage('a plain string throw')).toBe('a plain string throw');
    expect(errorMessage('')).toBe('Something went wrong while rendering this page.');
    expect(errorMessage('   ')).toBe('Something went wrong while rendering this page.');
  });

  it('falls back for an Error with an empty message', () => {
    expect(errorMessage(new Error(''))).toBe('Something went wrong while rendering this page.');
  });
});

describe('logBoundaryError', () => {
  afterEach(() => vi.restoreAllMocks());

  it('surfaces the error for diagnosis via console.error (AC4)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = new Error('boom');
    logBoundaryError(error, 'at SearchPage');
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]).toContain(error);
  });

  it('tolerates a missing component stack', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logBoundaryError('kaboom');
    expect(spy).toHaveBeenCalledOnce();
  });
});
