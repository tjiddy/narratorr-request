import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted so the mock factory can reference them (vi.mock is hoisted above imports).
const m = vi.hoisted(() => ({
  discovery: vi.fn(),
  randomPKCECodeVerifier: vi.fn(),
  calculatePKCECodeChallenge: vi.fn(),
  randomState: vi.fn(),
  randomNonce: vi.fn(),
  buildAuthorizationUrl: vi.fn(),
  authorizationCodeGrant: vi.fn(),
  fetchUserInfo: vi.fn(),
}));
vi.mock('openid-client', () => m);

import { OidcService, makeOidcMapper, type OidcServiceConfig } from './oidc.service.js';
import { ApiError } from '../util/errors.js';

const CONFIG: Readonly<unknown> = { issuer: 'mock-config' }; // opaque Configuration sentinel
const cfg: OidcServiceConfig = {
  issuer: 'https://idp.example/',
  clientId: 'client-1',
  clientSecret: 'secret-1',
  redirectUri: 'https://app.example/api/auth/oidc/callback',
  scope: 'openid profile email',
  label: 'Authelia',
};

const VERIFIER = 'pkce-verifier-123';
const CHALLENGE = 'pkce-challenge-abc';
const STATE = 'state-xyz';
const NONCE = 'nonce-789';
const PENDING_TTL_MS = 10 * 60 * 1000; // mirror the non-exported module constant

function tokens(claims: Record<string, unknown>, accessToken = 'access-token-1') {
  return { claims: () => claims, access_token: accessToken };
}

function callbackUrl(state: string | null) {
  const u = new URL('https://app.example/api/auth/oidc/callback');
  u.searchParams.set('code', 'auth-code-1');
  if (state !== null) u.searchParams.set('state', state);
  return u.href;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.discovery.mockResolvedValue(CONFIG);
  m.randomPKCECodeVerifier.mockReturnValue(VERIFIER);
  m.calculatePKCECodeChallenge.mockResolvedValue(CHALLENGE);
  m.randomState.mockReturnValue(STATE);
  m.randomNonce.mockReturnValue(NONCE);
  m.buildAuthorizationUrl.mockReturnValue(new URL('https://idp.example/authorize?go=1'));
  m.authorizationCodeGrant.mockResolvedValue(tokens({ sub: 'user-sub' }));
  m.fetchUserInfo.mockResolvedValue({ sub: 'user-sub' });
});

const mapper = makeOidcMapper('Authelia');
function makeService(validate?: (p: unknown) => void) {
  return new OidcService(cfg, mapper, validate);
}

describe('OidcService.buildAuthUrl (AC1)', () => {
  it('builds the authorization URL with S256, configured redirect + scope, and the generated state/nonce', async () => {
    const url = await makeService().buildAuthUrl(0);

    expect(url).toBe('https://idp.example/authorize?go=1');
    expect(m.buildAuthorizationUrl).toHaveBeenCalledTimes(1);
    const [config, params] = m.buildAuthorizationUrl.mock.calls[0]!;
    expect(config).toBe(CONFIG);
    expect(params).toMatchObject({
      redirect_uri: cfg.redirectUri,
      scope: cfg.scope,
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
      state: STATE,
      nonce: NONCE,
    });
  });

  it('records a pending entry for the exact generated state (callback for that state proceeds to exchange)', async () => {
    const svc = makeService();
    await svc.buildAuthUrl(0);
    // Behavioral proof the pending entry exists for STATE: the callback gets past the
    // state guard and into the token exchange rather than throwing OIDC_STATE.
    await svc.handleCallback(callbackUrl(STATE), 0);
    expect(m.authorizationCodeGrant).toHaveBeenCalledTimes(1);
  });
});

describe('OidcService.handleCallback happy path (AC2)', () => {
  it('passes the stored pkce verifier / expected state / expected nonce to the token exchange', async () => {
    const svc = makeService();
    await svc.buildAuthUrl(0);
    const profile = await svc.handleCallback(callbackUrl(STATE), 0);

    expect(m.authorizationCodeGrant).toHaveBeenCalledTimes(1);
    const [config, current, opts] = m.authorizationCodeGrant.mock.calls[0]!;
    expect(config).toBe(CONFIG);
    expect((current as URL).searchParams.get('state')).toBe(STATE);
    expect(opts).toEqual({
      pkceCodeVerifier: VERIFIER,
      expectedState: STATE,
      expectedNonce: NONCE,
    });
    expect(profile).toMatchObject({ subject: 'user-sub' });
  });
});

describe('OidcService.handleCallback state defenses (AC3)', () => {
  it('throws OIDC_STATE 400 when state is missing', async () => {
    const svc = makeService();
    await svc.buildAuthUrl(0);
    await expect(svc.handleCallback(callbackUrl(null), 0)).rejects.toMatchObject({
      code: 'OIDC_STATE',
      statusCode: 400,
    });
    expect(m.authorizationCodeGrant).not.toHaveBeenCalled();
  });

  it('throws OIDC_STATE 400 for a forged/unknown state', async () => {
    const svc = makeService();
    await svc.buildAuthUrl(0);
    await expect(svc.handleCallback(callbackUrl('not-the-real-state'), 0)).rejects.toMatchObject({
      code: 'OIDC_STATE',
      statusCode: 400,
    });
    expect(m.authorizationCodeGrant).not.toHaveBeenCalled();
  });

  it('rejects a pending entry past PENDING_TTL_MS (boundary is >)', async () => {
    const svc = makeService();
    await svc.buildAuthUrl(0);
    // Just inside the TTL still works; strictly past it is rejected.
    await expect(svc.handleCallback(callbackUrl(STATE), PENDING_TTL_MS + 1)).rejects.toMatchObject({
      code: 'OIDC_STATE',
      statusCode: 400,
    });
    expect(m.authorizationCodeGrant).not.toHaveBeenCalled();
  });

  it('honors the TTL boundary: exactly at PENDING_TTL_MS still exchanges', async () => {
    const svc = makeService();
    await svc.buildAuthUrl(0);
    await svc.handleCallback(callbackUrl(STATE), PENDING_TTL_MS);
    expect(m.authorizationCodeGrant).toHaveBeenCalledTimes(1);
  });

  it('rejects a replayed callback (pending deleted on first use)', async () => {
    const svc = makeService();
    await svc.buildAuthUrl(0);
    await svc.handleCallback(callbackUrl(STATE), 0); // first use consumes the pending
    await expect(svc.handleCallback(callbackUrl(STATE), 0)).rejects.toMatchObject({
      code: 'OIDC_STATE',
      statusCode: 400,
    });
    expect(m.authorizationCodeGrant).toHaveBeenCalledTimes(1);
  });
});

describe('OidcService discovery / exchange / userinfo (AC4)', () => {
  it('maps a token-exchange failure to OIDC_EXCHANGE 502', async () => {
    const svc = makeService();
    await svc.buildAuthUrl(0);
    m.authorizationCodeGrant.mockRejectedValueOnce(new Error('boom'));
    await expect(svc.handleCallback(callbackUrl(STATE), 0)).rejects.toMatchObject({
      code: 'OIDC_EXCHANGE',
      statusCode: 502,
    });
  });

  it('maps a discovery failure to OIDC_DISCOVERY 502 and retries discovery on the next call (no cached rejection)', async () => {
    const svc = makeService();
    m.discovery.mockRejectedValueOnce(new Error('idp down'));

    await expect(svc.buildAuthUrl(0)).rejects.toMatchObject({
      code: 'OIDC_DISCOVERY',
      statusCode: 502,
    });

    // Cached promise was nulled on failure, so a subsequent call re-invokes discovery.
    const url = await svc.buildAuthUrl(0);
    expect(url).toBe('https://idp.example/authorize?go=1');
    expect(m.discovery).toHaveBeenCalledTimes(2);
  });

  it('swallows a userinfo failure and builds the profile from id-token claims', async () => {
    const svc = makeService();
    await svc.buildAuthUrl(0);
    m.authorizationCodeGrant.mockResolvedValueOnce(
      tokens({ sub: 'user-sub', preferred_username: 'todd', email: 't@x.com' }),
    );
    m.fetchUserInfo.mockRejectedValueOnce(new Error('userinfo 500'));

    const profile = await svc.handleCallback(callbackUrl(STATE), 0);
    expect(profile).toEqual({ subject: 'user-sub', username: 'todd', email: 't@x.com', thumb: null });
  });

  it('runs the provider validate gate on the mapped profile (a throw rejects the login)', async () => {
    const svc = makeService(() => {
      throw new ApiError(403, 'FORBIDDEN', 'not allowed');
    });
    await svc.buildAuthUrl(0);
    await expect(svc.handleCallback(callbackUrl(STATE), 0)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

const map = makeOidcMapper('Test');

describe('makeOidcMapper', () => {
  it('maps sub + preferred_username + email + picture', () => {
    expect(map({ sub: 'abc', preferred_username: 'todd', email: 't@x.com', picture: 'p.jpg' }, null)).toEqual({
      subject: 'abc',
      username: 'todd',
      email: 't@x.com',
      thumb: 'p.jpg',
    });
  });

  it('falls back through username/name/userinfo, then to the subject for the username', () => {
    expect(map({ sub: 'abc' }, { preferred_username: 'todd' })).toMatchObject({ username: 'todd' });
    expect(map({ sub: 'abc', name: 'Todd J' }, null)).toMatchObject({ username: 'Todd J' });
    expect(map({ sub: 'abc' }, null)).toEqual({ subject: 'abc', username: 'abc', email: null, thumb: null });
  });

  it('throws OIDC_CLAIMS when there is no usable subject', () => {
    expect(() => map({}, null)).toThrow(/usable subject/);
  });

  it('ignores non-string claims (array/object/number) rather than coercing them', () => {
    // A provider that returns sub as a number/array must not yield a bogus subject.
    expect(() => map({ sub: 12345 }, null)).toThrow(/usable subject/);
    expect(() => map({ sub: ['a', 'b'] }, null)).toThrow(/usable subject/);
  });

  it('rejects an oversized subject/username (bounds provider-controlled identity keys)', () => {
    const huge = 'x'.repeat(300);
    expect(() => map({ sub: huge }, null)).toThrow(/exceeds/);
    expect(() => map({ sub: 'ok', preferred_username: huge }, null)).toThrow(/exceeds/);
  });

  it('honors per-provider claim overrides', () => {
    const custom = makeOidcMapper('Custom', {
      subjectClaim: 'oid',
      usernameClaim: 'login',
      emailClaim: 'mail',
    });
    expect(custom({ oid: 'X1', login: 'gamer', mail: 'g@x.com', sub: 'ignored' }, null)).toEqual({
      subject: 'X1',
      username: 'gamer',
      email: 'g@x.com',
      thumb: null,
    });
  });

  it('reads an override claim from userinfo when absent from id-token claims', () => {
    const custom = makeOidcMapper('Custom', { usernameClaim: 'login' });
    expect(custom({ sub: 'X1' }, { login: 'fromUserinfo' })).toMatchObject({ username: 'fromUserinfo' });
  });

  // issue #120: the email claim is now routed through the shared deliverability gate so a
  // hostile/misconfigured IdP can never seed a garbage address the availability path would send to.
  describe('email claim deliverability gate (issue #120)', () => {
    it('maps a malformed email claim to null (never a stored garbage address)', () => {
      expect(map({ sub: 'abc', email: 'not-an-email' }, null).email).toBeNull();
    });

    it('maps an over-length (>254) email claim to null', () => {
      const over = `${'a'.repeat(250)}@example.com`; // 262 chars
      expect(over.length).toBeGreaterThan(254);
      expect(map({ sub: 'abc', email: over }, null).email).toBeNull();
    });

    it('normalizes a valid mixed-case/padded email claim (trim + lowercase)', () => {
      expect(map({ sub: 'abc', email: '  T@X.COM ' }, null).email).toBe('t@x.com');
    });
  });
});
