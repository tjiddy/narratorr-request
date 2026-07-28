import { describe, it, expect } from 'vitest';
import type { FastifyRequest } from 'fastify';
import {
  authRateLimitOptions,
  ebookDownloadRateLimitOptions,
  ebookDownloadKeyGenerator,
  ebookDownloadAllowList,
  EBOOK_DOWNLOAD_MAX,
  EBOOK_DOWNLOAD_WINDOW,
  EBOOK_DOWNLOAD_PLACEHOLDER_KEY,
} from './rate-limit.js';
import type { AuthUser } from '../types.js';

// Call the keyGenerator directly with a stub request — the limiter itself (429 trip) is
// covered by the auth-route integration test; here we pin the keying logic.
const keyFor = (ip: string, body?: unknown) =>
  authRateLimitOptions.keyGenerator({ ip, body } as unknown as FastifyRequest);

describe('authRateLimitOptions registration flags', () => {
  it('is opt-in (global: false) so the polling endpoints are never throttled', () => {
    expect(authRateLimitOptions.global).toBe(false);
  });

  it('runs on the preHandler hook so the parsed body (email) is available to the keyGenerator', () => {
    expect(authRateLimitOptions.hook).toBe('preHandler');
  });
});

describe('authRateLimitOptions.keyGenerator', () => {
  it('keys two emails from the same IP into separate buckets', () => {
    const a = keyFor('1.2.3.4', { email: 'alice@example.com' });
    const b = keyFor('1.2.3.4', { email: 'bob@example.com' });
    expect(a).toBe('1.2.3.4|alice@example.com');
    expect(b).toBe('1.2.3.4|bob@example.com');
    expect(a).not.toBe(b);
  });

  it('falls back to IP alone when email is missing, null, non-string, or empty', () => {
    expect(keyFor('1.2.3.4')).toBe('1.2.3.4|');
    expect(keyFor('1.2.3.4', {})).toBe('1.2.3.4|');
    expect(keyFor('1.2.3.4', { email: null })).toBe('1.2.3.4|');
    expect(keyFor('1.2.3.4', { email: 42 })).toBe('1.2.3.4|');
    expect(keyFor('1.2.3.4', { email: '' })).toBe('1.2.3.4|');
  });

  it('trims and lowercases the email', () => {
    expect(keyFor('1.2.3.4', { email: '  A@B.COM ' })).toBe('1.2.3.4|a@b.com');
  });

  it('bounds the email at 64 chars (.slice(0, 64))', () => {
    const long = 'x'.repeat(100);
    expect(keyFor('1.2.3.4', { email: long })).toBe(`1.2.3.4|${'x'.repeat(64)}`);
  });
});

// ---------------------------------------------------------------------------
// The companion-EPUB download cap (issue #146 AC28-AC31, AC37). Per USER, not per IP — and
// deliberately EXEMPT for anyone the route's guard would refuse anyway, so throttling can never
// pre-empt a deterministic 401/403.
// ---------------------------------------------------------------------------

const userAt = (over: Partial<AuthUser>): AuthUser => ({
  id: 1,
  publicId: 'us_alice',
  username: 'alice',
  role: 'user',
  status: 'active',
  ...over,
});

/** Call the keyGenerator / allowList directly with a stub request (the limiter reads only these). */
const reqFor = (user?: AuthUser, ip = '1.2.3.4') => ({ ip, user }) as unknown as FastifyRequest;

describe('ebookDownloadRateLimitOptions', () => {
  it('freezes the documented cap: 10 downloads per user per minute (AC29)', () => {
    expect(EBOOK_DOWNLOAD_MAX).toBe(10);
    expect(EBOOK_DOWNLOAD_WINDOW).toBe('1 minute');
    expect(ebookDownloadRateLimitOptions.max).toBe(EBOOK_DOWNLOAD_MAX);
    expect(ebookDownloadRateLimitOptions.timeWindow).toBe(EBOOK_DOWNLOAD_WINDOW);
  });

  it('wires the exported keyGenerator and allowList (not inline copies)', () => {
    expect(ebookDownloadRateLimitOptions.keyGenerator).toBe(ebookDownloadKeyGenerator);
    expect(ebookDownloadRateLimitOptions.allowList).toBe(ebookDownloadAllowList);
  });
});

describe('ebookDownloadKeyGenerator (AC28, AC30)', () => {
  it('keys on the user publicId, never on the IP', () => {
    expect(ebookDownloadKeyGenerator(reqFor(userAt({})))).toBe('us_alice');
    // Same user, different IPs: still ONE bucket — roaming must not reset a cap.
    expect(ebookDownloadKeyGenerator(reqFor(userAt({}), '9.9.9.9'))).toBe('us_alice');
  });

  it('puts two users behind ONE IP in different buckets (the household case)', () => {
    const a = ebookDownloadKeyGenerator(reqFor(userAt({ publicId: 'us_alice' })));
    const b = ebookDownloadKeyGenerator(reqFor(userAt({ publicId: 'us_bob' })));
    expect(a).not.toBe(b);
  });

  it('is TOTAL: no request.user yields the placeholder rather than throwing', () => {
    // The plugin computes the key BEFORE evaluating the allowList, so a throwing generator would
    // 500 every anonymous caller instead of letting the guard answer 401.
    expect(() => ebookDownloadKeyGenerator(reqFor(undefined))).not.toThrow();
    expect(ebookDownloadKeyGenerator(reqFor(undefined))).toBe(EBOOK_DOWNLOAD_PLACEHOLDER_KEY);
  });

  it('cannot collide with a real key — publicIds are prefixed, the placeholder is not', () => {
    expect(EBOOK_DOWNLOAD_PLACEHOLDER_KEY.startsWith('us_')).toBe(false);
  });
});

describe('ebookDownloadAllowList — guard precedence over throttling (AC37)', () => {
  it.each([
    ['no user at all', undefined],
    ['a pending account', userAt({ status: 'pending' })],
    ['a rejected account', userAt({ status: 'rejected' })],
  ] as const)('exempts %s, so the guard is what answers them', (_label, user) => {
    expect(ebookDownloadAllowList(reqFor(user))).toBe(true);
  });

  it('does NOT exempt an active user', () => {
    expect(ebookDownloadAllowList(reqFor(userAt({})))).toBe(false);
  });

  it('does NOT exempt an admin, even a pending one (isApprovedUser treats admins as active)', () => {
    // The exemption must track `isApprovedUser` exactly — the same predicate `requireActiveUser`
    // enforces with — or a caller the guard lets through would slip the cap.
    expect(ebookDownloadAllowList(reqFor(userAt({ role: 'admin', status: 'pending' })))).toBe(false);
  });
});
