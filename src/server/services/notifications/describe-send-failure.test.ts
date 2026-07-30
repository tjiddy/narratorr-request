import { describe, it, expect } from 'vitest';
import { describeSendFailure } from './describe-send-failure.js';

const UNREACHABLE = 'Could not reach the destination — check the URL, including whether it redirects.';
const TIMEOUT = 'The destination did not respond in time.';

describe('describeSendFailure — network class (fetch rejects as TypeError)', () => {
  it('maps a redirect rejection (TypeError with an "unexpected redirect" cause) to the redirect-aware copy', () => {
    // This is the shape `redirect: 'error'` produces on Node 24 — the cause text is NOT what
    // classifies it (see AC2 / the `fetch-redirect-error-invariant` learning); the TYPE is.
    const err = new TypeError('fetch failed', { cause: new Error('unexpected redirect') });
    expect(describeSendFailure(err)).toBe(UNREACHABLE);
  });

  it('maps a TypeError with a DIFFERENT message to the SAME copy (no message matching)', () => {
    // Anti-regression against re-introducing a `'fetch failed'` string match, and the real
    // "admin pasted a malformed URL" case.
    expect(describeSendFailure(new TypeError('Failed to parse URL from ://nope'))).toBe(UNREACHABLE);
  });

  it('maps a bare TypeError (no message at all) to the same copy', () => {
    expect(describeSendFailure(new TypeError())).toBe(UNREACHABLE);
  });
});

describe('describeSendFailure — timeout class (AbortSignal.timeout rejection)', () => {
  it('maps a real DOMException named TimeoutError to the timeout copy', () => {
    // DOMException instanceof Error === true in Node, so an `instanceof Error` branch ordered
    // ahead of this one would swallow it — assert the real runtime shape explicitly.
    const err = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    expect(err).toBeInstanceOf(Error); // documents why the branch order matters
    expect(describeSendFailure(err)).toBe(TIMEOUT);
  });

  it('classifies STRUCTURALLY: any object whose name is TimeoutError takes the timeout branch', () => {
    // AC1 states the predicate as `name === 'TimeoutError'`, not `instanceof DOMException` —
    // a DOMException-only implementation would narrow the contract and pass the case above.
    expect(describeSendFailure({ name: 'TimeoutError', message: 'whatever' })).toBe(TIMEOUT);
  });

  it('a plain Error renamed TimeoutError also takes the timeout branch', () => {
    const err = new Error('aborted');
    err.name = 'TimeoutError';
    expect(describeSendFailure(err)).toBe(TIMEOUT);
  });
});

describe('describeSendFailure — fallback keeps redact() (adapter-constructed + SMTP errors)', () => {
  it('returns an adapter-constructed message verbatim', () => {
    expect(describeSendFailure(new Error('ntfy responded 500'))).toBe('ntfy responded 500');
  });

  it('returns a nodemailer-shaped SMTP error verbatim (no SMTP-specific copy — AC7)', () => {
    const err: Error & { code?: string } = new Error('connect ECONNREFUSED 127.0.0.1:587');
    err.code = 'ECONNREFUSED';
    expect(describeSendFailure(err)).toBe('connect ECONNREFUSED 127.0.0.1:587');
  });

  it('still scrubs a URL-class secret by PATTERN on the fallback path (Slack capability URL)', () => {
    const out = describeSendFailure(new Error('posting to https://hooks.slack.com/services/T00/B00/FALLBACKSECRET failed'));
    expect(out).not.toContain('FALLBACKSECRET');
    expect(out).not.toContain('T00/B00');
    expect(out).toContain('hooks.slack.com/services');
  });

  it('still scrubs a VALUE-class secret passed via `secrets` on the fallback path (Gotify token)', () => {
    const token = 'gotify-app-token-FALLBACKVALUE-123';
    const out = describeSendFailure(new Error(`Gotify auth rejected key=${token}`), [token]);
    expect(out).not.toContain(token);
  });
});

describe('describeSendFailure — the mapped branches are static (leak-proof by construction, AC3)', () => {
  it('a TypeError whose message embeds a Slack capability URL leaks neither the secret nor the host', () => {
    const err = new TypeError('fetch failed to https://hooks.slack.com/services/T00/B00/MAPPEDSECRET');
    const out = describeSendFailure(err);
    expect(out).toBe(UNREACHABLE);
    expect(out).not.toContain('MAPPEDSECRET');
    expect(out).not.toContain('hooks.slack.com');
  });

  it('a TimeoutError whose message embeds a token leaks nothing', () => {
    const err = new DOMException('timed out posting to https://ntfy.example.com with token TIMEOUTSECRET', 'TimeoutError');
    const out = describeSendFailure(err, ['TIMEOUTSECRET']);
    expect(out).toBe(TIMEOUT);
    expect(out).not.toContain('TIMEOUTSECRET');
    expect(out).not.toContain('ntfy.example.com');
  });
});
