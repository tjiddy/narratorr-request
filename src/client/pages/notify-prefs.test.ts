import { describe, it, expect } from 'vitest';
import { toggleNotifyOn, optInDisabled, shouldShowNudge } from './notify-prefs.js';

describe('toggleNotifyOn', () => {
  it('adds a transition when enabled', () => {
    expect(toggleNotifyOn([], 'available', true)).toEqual(['available']);
  });

  it('removes a transition when disabled', () => {
    expect(toggleNotifyOn(['available'], 'available', false)).toEqual([]);
  });

  it('is idempotent — enabling an already-present transition does not duplicate it', () => {
    expect(toggleNotifyOn(['available'], 'available', true)).toEqual(['available']);
  });

  it('does not mutate the input array', () => {
    const current: ('available')[] = [];
    toggleNotifyOn(current, 'available', true);
    expect(current).toEqual([]);
  });

  it('orders the result by NOTIFIABLE_TRANSITIONS regardless of click order (stable payload)', () => {
    // v1 has a single transition, so the payload is deterministic; this guards the ordering
    // contract as the const grows (denied/failed follow-ups).
    expect(toggleNotifyOn([], 'available', true)).toEqual(['available']);
  });
});

describe('optInDisabled', () => {
  it('is disabled when email delivery is unavailable', () => {
    expect(optInDisabled(false)).toBe(true);
  });
  it('is enabled when email delivery is available', () => {
    expect(optInDisabled(true)).toBe(false);
  });
});

describe('shouldShowNudge', () => {
  it('shows when email is available, nothing opted in, and not dismissed', () => {
    expect(shouldShowNudge(true, [], false)).toBe(true);
  });
  it('hides when email delivery is unavailable (nothing to nudge toward)', () => {
    expect(shouldShowNudge(false, [], false)).toBe(false);
  });
  it('hides once the user has opted into something', () => {
    expect(shouldShowNudge(true, ['available'], false)).toBe(false);
  });
  it('hides once dismissed (one-time)', () => {
    expect(shouldShowNudge(true, [], true)).toBe(false);
  });
});
