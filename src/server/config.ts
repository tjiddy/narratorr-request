import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

// Load .env for native dev (no-op if absent / already in env). Production passes
// real env vars (docker-compose), so a missing file is fine.
try {
  process.loadEnvFile('.env');
} catch {
  // no .env — rely on process.env
}

// Anchor relative paths (the sqlite file) to the repo root — two levels up from
// this module (src/server in dev, dist/server after bundling) — NOT process.cwd().
export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const resolveFromRoot = (p: string) => (path.isAbsolute(p) ? p : path.resolve(APP_ROOT, p));

// useUnknownInCatchVariables-safe error description (no `as Error`).
const describeErr = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Resolve a possibly file-sourced secret (Docker `_FILE` convention): prefer `<NAME>_FILE`
 * (read the file + `.trim()`; throw a startup error if it is unreadable OR empty-after-trim),
 * else fall back to the raw `process.env[<NAME>]` (untrimmed, unchanged — may be `undefined`).
 * Does NOT make the secret required; it only enforces that an explicitly-set `_FILE` is usable.
 * The file value is returned straight to the caller — never written back to `process.env`, so
 * `docker inspect` / `/proc/<pid>/environ` never expose it.
 */
function readSecret(name: string): string | undefined {
  const filePath = process.env[`${name}_FILE`];
  if (filePath !== undefined && filePath.trim() !== '') {
    const resolved = filePath.trim();
    let raw: string;
    try {
      raw = readFileSync(resolved, 'utf8');
    } catch (err: unknown) {
      // Name the var + path, never the contents.
      throw new Error(`${name}_FILE ("${resolved}") could not be read: ${describeErr(err)}`, { cause: err });
    }
    const value = raw.trim();
    if (value === '') throw new Error(`${name}_FILE ("${resolved}") is empty after trimming.`);
    return value;
  }
  return process.env[name]; // unchanged: raw, untrimmed, possibly undefined
}

// empty/absent → default, otherwise coerce STRICTLY (Number("60abc") = NaN, which
// z.number() rejects — unlike parseInt which would yield 60).
const intFromString = (def: string) =>
  z
    .string()
    .default(def)
    .transform((v) => Number(v.trim() === '' ? def : v.trim()))
    .pipe(z.number().int());

const TRUTHY = ['1', 'true', 'yes', 'on'];
const boolFromString = z
  .string()
  .default('')
  .transform((v) => TRUTHY.includes(v.trim().toLowerCase()));

// Like boolFromString but with a configurable default for the unset/blank case
// (used for LOCAL_AUTH, which defaults ON so a fresh container always has a way in).
const boolFromStringDefault = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? def : TRUTHY.includes(v.trim().toLowerCase())));

// Comma/semicolon separated → trimmed non-empty list.
const csv = z
  .string()
  .default('')
  .transform((v) =>
    v
      .split(/[,;]/)
      .map((s) => s.trim())
      .filter(Boolean),
  );

const envSchema = z.object({
  PORT: intFromString('3000').pipe(z.number().int().min(1).max(65535)),
  NODE_ENV: z.string().default(''),
  CORS_ORIGIN: z.string().default('http://localhost:5173').transform((v) => v || 'http://localhost:5173'),
  // Default to loopback: with AUTH_BYPASS on, binding to 0.0.0.0 would expose an
  // unauthenticated admin. Real LAN/Docker deployments set BIND_HOST=0.0.0.0
  // explicitly (and run with auth on, not bypass).
  BIND_HOST: z.string().default('127.0.0.1').transform((v) => v || '127.0.0.1'),

  DATABASE_PATH: z
    .string()
    .default('./narratorr-requests.db')
    .transform((v) => resolveFromRoot(v || './narratorr-requests.db')),

  // Declared here only so the env surface stays documented in one schema — the actual runtime
  // value is sourced via readSecret() below (supports the _FILE convention) and bypasses this
  // field's parsed value, so schema-level constraints added here won't apply.
  SESSION_SECRET: z.string().optional(),
  // Optional: dedicated key for encrypting connector secrets at rest. When unset,
  // the key is derived from SESSION_SECRET (see secret-codec.deriveSettingsKey).
  // Same readSecret() bypass as SESSION_SECRET above applies here too.
  SETTINGS_KEY: z.string().optional(),

  // Auth.
  AUTH_BYPASS: boolFromString,
  // Escape hatch to allow AUTH_BYPASS while bound to a non-loopback host.
  ALLOW_INSECURE_AUTH_BYPASS: boolFromString,
  // Local email/password auth. Default ON so a fresh container always has a way in;
  // set false (LOCAL_AUTH=false) for pure-OIDC deployments.
  LOCAL_AUTH: boolFromStringDefault(true),
  // Comma/semicolon list of OIDC provider ids (each `[a-z0-9_]`, 1–32 chars). Each id's
  // settings live in `OIDC_<ID>_*` env vars (see parseOidcProviders + docs). Plex (via
  // bridge) and Authelia are just provider instances now — no special-casing.
  OIDC_PROVIDERS: csv,
  // Optional: pin admin to one identity as "<provider>:<subjectOrUsername>" (e.g.
  // "authelia:todd"). When set, first-user-auto-admin is DISABLED.
  BOOTSTRAP_ADMIN: z.string().optional(),
  // Reverse-proxy awareness for client IPs (used for rate-limit keying). '' / 'false' =
  // off; 'true' = trust all proxies; or a CIDR/IP list or hop count passed to Fastify.
  // Named to match narratorr's env (both map to Fastify's `trustProxy`).
  TRUSTED_PROXIES: z.string().default(''),

  // "There is TLS in front of us" signal. Raw string (like SESSION_SECRET) so the default can
  // depend on isProd in the post-parse block below — the schema transform runs pre-isProd and
  // can't express that. Gates the TLS-assuming surfaces: CSP `upgrade-insecure-requests`, the
  // HSTS header, and the `Secure` session cookie. Set BEHIND_TLS=false to run a prod image over
  // plain HTTP (else assets fail with ERR_SSL_PROTOCOL_ERROR and login won't persist).
  BEHIND_TLS: z.string().optional(),

  // The default request quota (limit + rolling window) is no longer env-configured — it's
  // admin-editable in the Settings UI and stored in app_settings. A fresh DB seeds a sane
  // default (10 requests / rolling 30 days) via SettingsService.ensure().

  // Display-only tab badge to tell a dev instance apart from prod when many tabs are open
  // (favicon accent recolor + `[<badge>] ` title prefix, applied client-side). Free-form string
  // (e.g. "dev"). This is the ONE display-only var in an otherwise auth+secrets env surface; it
  // holds NO secret and is served publicly via `GET /api/config`. Unset / blank = prod = zero
  // behavior change. Blank/whitespace collapses to undefined; a non-empty value is trimmed.
  INSTANCE_BADGE: z
    .string()
    .optional()
    .transform((v) => {
      const t = v?.trim();
      return t !== undefined && t !== '' ? t : undefined;
    }),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  throw new Error(`Invalid environment config:\n${z.prettifyError(parsed.error)}`);
}
const env = parsed.data;

const isProd = env.NODE_ENV === 'production';
const isDev = !isProd;

// The narratorr connection + notification channels are NOT env-configured — they're
// edited on the admin Settings page and stored (secrets encrypted) in the DB. A fresh
// container boots with them unset; the admin configures them in the UI. This keeps the
// app a low-friction "plug-in" sidecar with a minimal env surface (auth + secrets only).

// Authentication is pluggable: AUTH_BYPASS (dev), local email/password, and N OIDC
// providers. Authorization (who may actually request) is the in-app approval queue, not
// auth. `standard` = the real stack (local + OIDC); `bypass` = dev shortcut only.
const authMode: 'bypass' | 'standard' = env.AUTH_BYPASS ? 'bypass' : 'standard';

if (authMode === 'bypass' && isProd) {
  throw new Error('AUTH_BYPASS must not be enabled in production (NODE_ENV=production).');
}
// AUTH_BYPASS makes every request the dev admin — refuse to expose that on a
// non-loopback interface unless explicitly acknowledged.
const isLoopbackBind = ['127.0.0.1', 'localhost', '::1'].includes(env.BIND_HOST);
if (authMode === 'bypass' && !isLoopbackBind && !env.ALLOW_INSECURE_AUTH_BYPASS) {
  throw new Error(
    `AUTH_BYPASS exposes an unauthenticated admin; refusing to bind to non-loopback host "${env.BIND_HOST}". ` +
      'Bind to 127.0.0.1, or set ALLOW_INSECURE_AUTH_BYPASS=1 if you truly intend this (e.g. an isolated LAN).',
  );
}

// Session secret: required in prod; dev auto-generates an ephemeral one (sessions
// drop on restart, which is fine locally).
let sessionSecret = readSecret('SESSION_SECRET');
if (!sessionSecret) {
  if (isProd) throw new Error('SESSION_SECRET is required in production.');
  sessionSecret = randomBytes(32).toString('hex');
}

export interface OidcProviderConfig {
  id: string; // lowercase slug; also the user's authProvider value + the route param
  label: string; // login-button text
  issuer: string;
  clientId: string;
  clientSecret: string | undefined;
  redirectUri: string;
  scope: string;
  subjectClaim: string | undefined;
  usernameClaim: string | undefined;
  emailClaim: string | undefined;
}

// Provider ids feed env var names AND a route param — restrict to a safe slug so an id
// like "../x" or "a/b" can never escape either context.
const PROVIDER_ID_RE = /^[a-z0-9_]{1,32}$/;

export function parseOidcProviders(ids: string[]): OidcProviderConfig[] {
  const seen = new Set<string>();
  return ids.map((id) => {
    if (!PROVIDER_ID_RE.test(id)) {
      throw new Error(`Invalid OIDC provider id "${id}" — must match ${PROVIDER_ID_RE} (lowercase letters, digits, _).`);
    }
    if (seen.has(id)) throw new Error(`Duplicate OIDC provider id "${id}" in OIDC_PROVIDERS.`);
    seen.add(id);
    const key = (suffix: string) => {
      const v = process.env[`OIDC_${id.toUpperCase()}_${suffix}`];
      return v && v.trim() !== '' ? v.trim() : undefined;
    };
    // Like key(), plus the `_FILE` branch for secret values. Unreadable `_FILE` throws (a
    // mis-mounted file must surface, not silently disable the secret); empty-after-trim maps to
    // undefined to match key()'s blank → undefined (the secret is optional). `_FILE` wins over
    // the plain var. id is uppercased to match key() (provider ids are validated lowercase).
    const secret = (suffix: string) => {
      const fileVar = process.env[`OIDC_${id.toUpperCase()}_${suffix}_FILE`];
      if (fileVar !== undefined && fileVar.trim() !== '') {
        const resolved = fileVar.trim();
        let raw: string;
        try {
          raw = readFileSync(resolved, 'utf8');
        } catch (e: unknown) {
          throw new Error(
            `OIDC_${id.toUpperCase()}_${suffix}_FILE ("${resolved}") could not be read: ${describeErr(e)}`,
            { cause: e },
          );
        }
        const v = raw.trim();
        return v === '' ? undefined : v;
      }
      return key(suffix);
    };
    const issuer = key('ISSUER');
    const clientId = key('CLIENT_ID');
    const redirectUri = key('REDIRECT_URI');
    const missing = (
      [
        ['ISSUER', issuer],
        ['CLIENT_ID', clientId],
        ['REDIRECT_URI', redirectUri],
      ] as const
    )
      .filter(([, v]) => !v)
      .map(([k]) => `OIDC_${id.toUpperCase()}_${k}`);
    if (missing.length) {
      throw new Error(`OIDC provider "${id}" is missing: ${missing.join(', ')}.`);
    }
    return {
      id,
      label: key('LABEL') ?? id.charAt(0).toUpperCase() + id.slice(1),
      issuer: issuer as string,
      clientId: clientId as string,
      clientSecret: secret('CLIENT_SECRET'),
      redirectUri: redirectUri as string,
      scope: key('SCOPE') ?? 'openid profile email',
      subjectClaim: key('SUBJECT_CLAIM'),
      usernameClaim: key('USERNAME_CLAIM'),
      emailClaim: key('EMAIL_CLAIM'),
    };
  });
}

export function parseBootstrapAdmin(raw: string | undefined): { provider: string; value: string } | null {
  if (!raw || raw.trim() === '') return null;
  const idx = raw.indexOf(':');
  if (idx <= 0 || idx === raw.length - 1) {
    throw new Error('BOOTSTRAP_ADMIN must be "<provider>:<subjectOrUsername>" (e.g. "authelia:todd").');
  }
  return { provider: raw.slice(0, idx).trim().toLowerCase(), value: raw.slice(idx + 1).trim() };
}

// Fastify trustProxy: '' / 'false' → off; 'true' → trust all; numeric → hop count;
// anything else → passed through as a CIDR/IP list.
export function parseTrustProxy(raw: string): boolean | number | string {
  const v = raw.trim();
  if (v === '' || v.toLowerCase() === 'false') return false;
  if (v.toLowerCase() === 'true') return true;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

const localAuth = env.LOCAL_AUTH;
const oidcProviders = authMode === 'standard' ? parseOidcProviders(env.OIDC_PROVIDERS) : [];
const bootstrapAdmin = parseBootstrapAdmin(env.BOOTSTRAP_ADMIN);
const trustProxy = parseTrustProxy(env.TRUSTED_PROXIES);

// Default-on in production (the common topology is behind a TLS-terminating proxy), so prod
// stays byte-identical to today. Reuse TRUTHY (1/true/yes/on) like every sibling flag; a blank
// string falls back to isProd. A prod plain-HTTP deploy must set BEHIND_TLS=false explicitly.
const behindTls =
  env.BEHIND_TLS !== undefined && env.BEHIND_TLS.trim() !== ''
    ? TRUTHY.includes(env.BEHIND_TLS.trim().toLowerCase())
    : isProd;

// A standard-mode install with no way in is a misconfiguration — fail fast at boot.
if (authMode === 'standard' && !localAuth && oidcProviders.length === 0) {
  throw new Error(
    'No authentication method is configured: enable LOCAL_AUTH or configure at least one OIDC ' +
      'provider via OIDC_PROVIDERS (+ OIDC_<ID>_* env). Or set AUTH_BYPASS=1 for local dev.',
  );
}

export const config = {
  port: env.PORT,
  bindHost: env.BIND_HOST,
  isDev,
  isProd,
  corsOrigin: env.CORS_ORIGIN,
  databasePath: env.DATABASE_PATH,
  sessionSecret,
  settingsKey: readSecret('SETTINGS_KEY'),
  trustProxy,
  behindTls,
  authMode,
  localAuth,
  oidcProviders,
  bootstrapAdmin,
  // Optional (exactOptionalPropertyTypes): present only when configured, omitted when unset —
  // so `AppConfig.instanceBadge` is `string | undefined` and the public route omits the field.
  ...(env.INSTANCE_BADGE !== undefined && { instanceBadge: env.INSTANCE_BADGE }),
};

export type AppConfig = typeof config;
