import { describe, it, expect } from 'vitest';
import { ebooksVisible, kindleDeliveryVisible, featuresQueryEnabled } from './features';
import type { FeaturesDto } from '@shared/schemas/features';
import type { MeDto } from '@shared/schemas/user';

const payload = (over: Partial<FeaturesDto> = {}): FeaturesDto => ({
  ebooksEnabled: false,
  kindleDeliveryAvailable: false,
  kindleSenderEmail: null,
  ...over,
});

const me = (over: Partial<MeDto> = {}): MeDto =>
  ({ publicId: 'us_1', username: 'ann', role: 'user', status: 'active', ...over }) as MeDto;

describe('ebooksVisible — fail-safe gate (#144)', () => {
  it('is false while loading, on error, and on an explicit false; true only on an explicit true', () => {
    expect(ebooksVisible({ data: undefined })).toBe(false); // still loading
    expect(ebooksVisible({ data: undefined, isError: true })).toBe(false); // failed
    expect(ebooksVisible({ data: payload({ ebooksEnabled: false }) })).toBe(false);
    expect(ebooksVisible({ data: payload({ ebooksEnabled: true }) })).toBe(true);
  });

  it('stays false on an error even when stale data says the feature is on', () => {
    // TanStack keeps the last successful `data` on a background refetch failure. Rendering off it
    // would leave a dead affordance up after an admin turned the feature off.
    expect(ebooksVisible({ data: payload({ ebooksEnabled: true }), isError: true })).toBe(false);
  });
});

describe('kindleDeliveryVisible — strictly narrower than the eBooks gate', () => {
  it('requires BOTH flags', () => {
    expect(kindleDeliveryVisible({ data: payload({ ebooksEnabled: true, kindleDeliveryAvailable: true }) })).toBe(true);
    expect(kindleDeliveryVisible({ data: payload({ ebooksEnabled: true, kindleDeliveryAvailable: false }) })).toBe(false);
    // The server never emits this combination; the client re-derives rather than trusting it.
    expect(kindleDeliveryVisible({ data: payload({ ebooksEnabled: false, kindleDeliveryAvailable: true }) })).toBe(false);
    expect(kindleDeliveryVisible({ data: undefined })).toBe(false);
    expect(kindleDeliveryVisible({ data: payload({ ebooksEnabled: true, kindleDeliveryAvailable: true }), isError: true })).toBe(false);
  });
});

describe('featuresQueryEnabled — only an active caller may fetch', () => {
  it('is false for a signed-out caller and for pending/rejected accounts', () => {
    // `/api/features` is requireActiveUser: it 401s on the login screen and 403s on the
    // pending/rejected screen, so firing it there only manufactures an error state.
    expect(featuresQueryEnabled(undefined)).toBe(false);
    expect(featuresQueryEnabled(me({ status: 'pending' }))).toBe(false);
    expect(featuresQueryEnabled(me({ status: 'rejected' }))).toBe(false);
  });

  it('is true for an active user, and for an admin at any status', () => {
    // Mirrors `requireActiveUser`: admins are never locked out by the approval queue.
    expect(featuresQueryEnabled(me({ status: 'active' }))).toBe(true);
    expect(featuresQueryEnabled(me({ role: 'admin', status: 'pending' }))).toBe(true);
    expect(featuresQueryEnabled(me({ role: 'admin', status: 'active' }))).toBe(true);
  });
});
