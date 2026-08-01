import * as oidc from 'openid-client';
import { badGateway, badRequest } from '../util/errors.js';
import { normalizeContactEmail } from '../../shared/schemas/user.js';

export interface OidcServiceConfig {
  issuer: string;
  clientId: string;
  clientSecret: string | undefined;
  redirectUri: string;
  /** OAuth scope string, e.g. 'openid profile email'. */
  scope: string;
  /** Label used in error messages + the login button (e.g. 'Plex', 'Authelia'). */
  label: string;
}

interface PendingAuth {
  codeVerifier: string;
  nonce: string;
  createdAt: number;
}

const PENDING_TTL_MS = 10 * 60 * 1000;

export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Generic OIDC authorization-code + PKCE client. The SECURITY-CRITICAL flow
 * (discovery, PKCE, state/nonce, token exchange) is single-sourced here and shared
 * by every provider; the provider-specific bits — how to turn claims into a profile,
 * and any post-auth gate — are injected. Pending {state→verifier} is held in memory
 * with a short TTL (single-instance MVP; a shared store is a fast-follow if scaled).
 */
export class OidcService<P> {
  private configPromise: Promise<oidc.Configuration> | null = null;
  private readonly pending = new Map<string, PendingAuth>();

  constructor(
    private readonly cfg: OidcServiceConfig,
    /** Map ID-token claims (+ best-effort userinfo) into a domain profile. */
    private readonly mapClaims: (claims: Record<string, unknown>, userinfo: Record<string, unknown> | null) => P,
    /** Optional gate run on the mapped profile; throw (e.g. forbidden) to reject. */
    private readonly validate: (profile: P) => void = () => {},
  ) {}

  private async getConfig(): Promise<oidc.Configuration> {
    if (!this.configPromise) {
      this.configPromise = oidc
        .discovery(new URL(this.cfg.issuer), this.cfg.clientId, this.cfg.clientSecret)
        .catch((err: unknown) => {
          this.configPromise = null;
          throw badGateway('OIDC_DISCOVERY', `${this.cfg.label} OIDC discovery failed: ${describe(err)}`);
        });
    }
    return this.configPromise;
  }

  /** Build the authorization URL and remember the PKCE verifier for the callback. */
  async buildAuthUrl(nowMs = Date.now()): Promise<string> {
    const config = await this.getConfig();
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();

    this.sweep(nowMs);
    this.pending.set(state, { codeVerifier, nonce, createdAt: nowMs });

    const url = oidc.buildAuthorizationUrl(config, {
      redirect_uri: this.cfg.redirectUri,
      scope: this.cfg.scope,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
      nonce,
    });
    return url.href;
  }

  /** Exchange the callback for tokens, map claims, and run the provider gate. */
  async handleCallback(callbackUrl: string, nowMs = Date.now()): Promise<P> {
    const config = await this.getConfig();
    const current = new URL(callbackUrl);
    const state = current.searchParams.get('state');
    if (!state) throw badRequest('OIDC_STATE', 'missing state');
    const pending = this.pending.get(state);
    if (!pending || nowMs - pending.createdAt > PENDING_TTL_MS) {
      throw badRequest('OIDC_STATE', 'unknown or expired auth state');
    }
    this.pending.delete(state);

    let tokens: oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers;
    try {
      tokens = await oidc.authorizationCodeGrant(config, current, {
        pkceCodeVerifier: pending.codeVerifier,
        expectedState: state,
        expectedNonce: pending.nonce,
      });
    } catch (err: unknown) {
      throw badGateway('OIDC_EXCHANGE', `${this.cfg.label} OIDC token exchange failed: ${describe(err)}`);
    }

    const claims = (tokens.claims() ?? {}) as Record<string, unknown>;
    let userinfo: Record<string, unknown> | null = null;
    const sub = str(claims['sub']);
    if (sub) {
      try {
        userinfo = (await oidc.fetchUserInfo(config, tokens.access_token, sub)) as Record<string, unknown>;
      } catch {
        userinfo = null; // userinfo is best-effort; claims may already suffice
      }
    }

    const profile = this.mapClaims(claims, userinfo);
    this.validate(profile);
    return profile;
  }

  private sweep(nowMs: number): void {
    for (const [state, p] of this.pending) {
      if (nowMs - p.createdAt > PENDING_TTL_MS) this.pending.delete(state);
    }
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// =============================================================================
// Generic claim mapper — shared by every OIDC provider
// =============================================================================

/** Provider-agnostic identity drawn from ID-token claims (+ best-effort userinfo). */
export interface OidcProfile {
  /** Stable provider subject — becomes the user's authSubject for this provider. */
  subject: string;
  /** Display username (mapped claim, falling back through common keys). */
  username: string;
  email: string | null;
  thumb: string | null;
}

/** Ceiling for provider-controlled identity claims (subject/username). */
const MAX_CLAIM_LEN = 255;

/** Optional per-provider claim overrides (defaults cover standard OIDC + the Plex bridge). */
export interface OidcClaimMapping {
  subjectClaim?: string | undefined;
  usernameClaim?: string | undefined;
  emailClaim?: string | undefined;
}

/**
 * Build a claim→profile mapper for a provider. The subject defaults to the standard
 * `sub`; the username falls through preferred_username → username → name (claims, then
 * userinfo) → subject. Any of these can be pinned to a specific claim via the mapping
 * (e.g. a provider that puts the stable id somewhere non-standard). Every value goes
 * through `str()` so a non-string/array/object claim is treated as absent, not coerced.
 */
export function makeOidcMapper(
  label: string,
  mapping: OidcClaimMapping = {},
): (claims: Record<string, unknown>, userinfo: Record<string, unknown> | null) => OidcProfile {
  return (claims, userinfo) => {
    const ui = userinfo ?? {};
    const pick = (claim: string | undefined, fallbacks: string[]): string | undefined => {
      if (claim) return str(claims[claim]) ?? str(ui[claim]);
      for (const k of fallbacks) {
        const v = str(claims[k]) ?? str(ui[k]);
        if (v) return v;
      }
      return undefined;
    };

    const subject = pick(mapping.subjectClaim, ['sub']);
    const username =
      pick(mapping.usernameClaim, ['preferred_username', 'username', 'name']) ?? subject;
    if (!subject || !username) {
      throw badGateway('OIDC_CLAIMS', `${label} OIDC response had no usable subject/username claim`);
    }
    // Bound provider-controlled values (subject is a unique-index key). A hostile or buggy
    // provider must not be able to write multi-kilobyte identity fields.
    if (subject.length > MAX_CLAIM_LEN || username.length > MAX_CLAIM_LEN) {
      throw badGateway('OIDC_CLAIMS', `${label} OIDC subject/username claim exceeds ${MAX_CLAIM_LEN} chars`);
    }
    return {
      subject,
      username,
      // Route the email claim through the shared deliverability gate: a malformed/over-length
      // claim maps to null (never a stored garbage address the availability path would try to
      // deliver to), and a valid claim is stored trimmed + lowercased (issue #120). An invalid
      // *present* claim thus reaches `upsertFromOidc`'s `profile.email ?? existing.email` coalesce
      // exactly like an absent claim — a returning user's last-known-good value is preserved.
      email: normalizeContactEmail(pick(mapping.emailClaim, ['email'])),
      thumb: str(claims['picture']) ?? str(claims['thumb']) ?? str(ui['picture']) ?? null,
    };
  };
}
