import { describe, it, expect, afterEach, afterAll, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// config.ts validates + applies its security guardrails at module *parse* time and throws
// synchronously on a bad env. To exercise the boot-time refusals without crashing the suite,
// each case stubs the env, resets the module cache, and re-imports a fresh copy. Restore the
// env after every test (vitest does NOT auto-unstub unless configured to).
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

// Real on-disk secret files for the _FILE-sourcing tests.
const secretsDir = mkdtempSync(join(tmpdir(), 'nr-secrets-'));
let fileSeq = 0;
function secretFile(contents: string): string {
  const p = join(secretsDir, `secret-${fileSeq++}`);
  writeFileSync(p, contents, 'utf8');
  return p;
}
const MISSING_PATH = join(secretsDir, 'does-not-exist');
afterAll(() => rmSync(secretsDir, { recursive: true, force: true }));

// readSecret() prefers <NAME>_FILE over the plain var, so an ambient SESSION_SECRET_FILE /
// SETTINGS_KEY_FILE (host env or a local .env) would silently change which branch a plain-env /
// no-_FILE test exercises. Neutralize them by default (stubbed to '' → readSecret treats blank as
// unset); a test exercising the _FILE path re-stubs them via the `env` arg, which wins (applied
// after, in the second loop).
const FILE_SECRET_VARS = ['SESSION_SECRET_FILE', 'SETTINGS_KEY_FILE'];

async function loadConfig(env: Record<string, string>) {
  for (const k of FILE_SECRET_VARS) {
    if (!(k in env)) vi.stubEnv(k, '');
  }
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  vi.resetModules();
  return import('./config.js');
}

describe('config — AUTH_BYPASS guardrails (CLAUDE.md security invariant)', () => {
  it('refuses AUTH_BYPASS in production', async () => {
    await expect(loadConfig({ AUTH_BYPASS: '1', NODE_ENV: 'production' })).rejects.toThrow(
      /AUTH_BYPASS must not be enabled in production/,
    );
  });

  it('refuses AUTH_BYPASS bound to a non-loopback host', async () => {
    await expect(loadConfig({ AUTH_BYPASS: '1', NODE_ENV: 'test', BIND_HOST: '0.0.0.0' })).rejects.toThrow(
      /non-loopback host/,
    );
  });

  it('allows a non-loopback AUTH_BYPASS bind with the explicit escape hatch', async () => {
    const mod = await loadConfig({
      AUTH_BYPASS: '1',
      NODE_ENV: 'test',
      BIND_HOST: '0.0.0.0',
      ALLOW_INSECURE_AUTH_BYPASS: '1',
    });
    expect(mod.config.authMode).toBe('bypass');
  });

  it('allows AUTH_BYPASS on a loopback bind', async () => {
    const mod = await loadConfig({ AUTH_BYPASS: '1', NODE_ENV: 'test', BIND_HOST: '127.0.0.1' });
    expect(mod.config.authMode).toBe('bypass');
  });
});

describe('config — SESSION_SECRET', () => {
  it('requires SESSION_SECRET in production', async () => {
    // AUTH_BYPASS is guarded before SESSION_SECRET and may be set ambiently (.env ships
    // AUTH_BYPASS=1 as the dev default), so neutralize it to isolate the guard under test.
    await expect(
      loadConfig({ NODE_ENV: 'production', SESSION_SECRET: '', AUTH_BYPASS: '' }),
    ).rejects.toThrow(/SESSION_SECRET is required in production/);
  });

  it('auto-generates an ephemeral SESSION_SECRET in dev', async () => {
    const mod = await loadConfig({ NODE_ENV: 'test', SESSION_SECRET: '' });
    expect(typeof mod.config.sessionSecret).toBe('string');
    expect(mod.config.sessionSecret.length).toBeGreaterThan(0);
  });

  it('boots a fully specified prod env without throwing (guards an over-eager future regression)', async () => {
    // The positive counterpart to the rejection cases: a legitimate prod boot must not throw.
    // AUTH_BYPASS / OIDC_PROVIDERS are explicitly neutralized (not omitted) — .env ships
    // AUTH_BYPASS=1 and loadConfig() only stubs supplied keys, so an ambient bypass would trip
    // the prod guard before this assertion is reached (mirrors the AUTH_BYPASS:'' pattern above).
    const mod = await loadConfig({
      NODE_ENV: 'production',
      SESSION_SECRET: 'a-prod-session-secret',
      LOCAL_AUTH: '1',
      AUTH_BYPASS: '',
      OIDC_PROVIDERS: '',
    });
    expect(mod.config.isProd).toBe(true);
  });
});

describe('config — _FILE secret sourcing (SESSION_SECRET / SETTINGS_KEY)', () => {
  it('SESSION_SECRET_FILE: reads and trims the file contents', async () => {
    const mod = await loadConfig({
      NODE_ENV: 'test',
      AUTH_BYPASS: '',
      SESSION_SECRET: '',
      SESSION_SECRET_FILE: secretFile('file-session-secret\n'),
    });
    expect(mod.config.sessionSecret).toBe('file-session-secret');
  });

  it('SESSION_SECRET_FILE wins when both the plain var and _FILE are set', async () => {
    const mod = await loadConfig({
      NODE_ENV: 'test',
      AUTH_BYPASS: '',
      SESSION_SECRET: 'plain-loser',
      SESSION_SECRET_FILE: secretFile('file-wins\n'),
    });
    expect(mod.config.sessionSecret).toBe('file-wins');
  });

  it('backward-compat: a plain SESSION_SECRET (no _FILE) is used raw/untrimmed', async () => {
    const mod = await loadConfig({ NODE_ENV: 'test', AUTH_BYPASS: '', SESSION_SECRET: 'raw-session  ' });
    expect(mod.config.sessionSecret).toBe('raw-session  ');
  });

  it('SESSION_SECRET_FILE that is unreadable (ENOENT) fails fast at startup', async () => {
    await expect(
      loadConfig({ NODE_ENV: 'test', AUTH_BYPASS: '', SESSION_SECRET: '', SESSION_SECRET_FILE: MISSING_PATH }),
    ).rejects.toThrow(/SESSION_SECRET_FILE.*could not be read/);
  });

  it('SESSION_SECRET_FILE empty-after-trim fails fast (no fall-through to dev generation)', async () => {
    await expect(
      loadConfig({ NODE_ENV: 'test', AUTH_BYPASS: '', SESSION_SECRET: '', SESSION_SECRET_FILE: secretFile('   \n') }),
    ).rejects.toThrow(/SESSION_SECRET_FILE.*empty after trimming/);
  });

  it('prod: SESSION_SECRET_FILE satisfies the required-in-prod check (no throw, no dev fallthrough)', async () => {
    const mod = await loadConfig({
      NODE_ENV: 'production',
      AUTH_BYPASS: '',
      OIDC_PROVIDERS: '',
      SESSION_SECRET: '',
      SESSION_SECRET_FILE: secretFile('prod-file-secret\n'),
    });
    expect(mod.config.isProd).toBe(true);
    expect(mod.config.sessionSecret).toBe('prod-file-secret');
  });

  it('never writes the _FILE value back to process.env (security regression guard)', async () => {
    const value = 'never-reentered-secret';
    // Force the plain var genuinely absent (not just blank) so we can assert it stays unset.
    vi.stubEnv('SESSION_SECRET', undefined as unknown as string);
    const mod = await loadConfig({
      NODE_ENV: 'test',
      AUTH_BYPASS: '',
      SESSION_SECRET_FILE: secretFile(`${value}\n`),
    });
    expect(mod.config.sessionSecret).toBe(value);
    expect(process.env.SESSION_SECRET).toBeUndefined();
  });

  it('error messages name the var + path but never the file contents', async () => {
    let unreadable = '';
    try {
      await loadConfig({ NODE_ENV: 'test', AUTH_BYPASS: '', SESSION_SECRET: '', SESSION_SECRET_FILE: MISSING_PATH });
    } catch (e) {
      unreadable = e instanceof Error ? e.message : String(e);
    }
    expect(unreadable).toContain('SESSION_SECRET_FILE');
    expect(unreadable).toContain(MISSING_PATH);

    vi.unstubAllEnvs();
    vi.resetModules();

    const contents = '   \n\t  ';
    let empty = '';
    try {
      await loadConfig({ NODE_ENV: 'test', AUTH_BYPASS: '', SESSION_SECRET: '', SESSION_SECRET_FILE: secretFile(contents) });
    } catch (e) {
      empty = e instanceof Error ? e.message : String(e);
    }
    expect(empty).toMatch(/empty after trimming/);
    expect(empty).not.toContain(contents);
    expect(empty).not.toContain('\n');
  });

  it('SETTINGS_KEY_FILE: reads and trims the file contents', async () => {
    const mod = await loadConfig({
      NODE_ENV: 'test',
      AUTH_BYPASS: '',
      SETTINGS_KEY_FILE: secretFile('file-settings-key\n'),
    });
    expect(mod.config.settingsKey).toBe('file-settings-key');
  });

  it('absent SETTINGS_KEY + SETTINGS_KEY_FILE → undefined, preserving the SESSION_SECRET-derived fallback', async () => {
    vi.stubEnv('SETTINGS_KEY', undefined as unknown as string);
    vi.stubEnv('SETTINGS_KEY_FILE', undefined as unknown as string);
    const mod = await loadConfig({ NODE_ENV: 'test', AUTH_BYPASS: '', SESSION_SECRET: 'sess-secret' });
    expect(mod.config.settingsKey).toBeUndefined();
    // With settingsKey absent, deriveSettingsKey must key off sessionSecret — assert the
    // derived keys match, mirroring how SecretCodec is wired at boot.
    const codec = await import('./util/secret-codec.js');
    const viaConfig = codec.deriveSettingsKey({
      settingsKey: mod.config.settingsKey,
      sessionSecret: mod.config.sessionSecret,
    });
    const viaSession = codec.deriveSettingsKey({ sessionSecret: mod.config.sessionSecret });
    expect(viaConfig.equals(viaSession)).toBe(true);
  });

  it('SETTINGS_KEY_FILE empty-after-trim fails fast (no SESSION_SECRET fallback)', async () => {
    await expect(
      loadConfig({ NODE_ENV: 'test', AUTH_BYPASS: '', SETTINGS_KEY_FILE: secretFile('  \n') }),
    ).rejects.toThrow(/SETTINGS_KEY_FILE.*empty after trimming/);
  });

  it('SETTINGS_KEY_FILE unreadable fails fast', async () => {
    await expect(
      loadConfig({ NODE_ENV: 'test', AUTH_BYPASS: '', SETTINGS_KEY_FILE: MISSING_PATH }),
    ).rejects.toThrow(/SETTINGS_KEY_FILE.*could not be read/);
  });

  it('backward-compat: a plain SETTINGS_KEY (no _FILE) is used raw/untrimmed', async () => {
    const mod = await loadConfig({ NODE_ENV: 'test', AUTH_BYPASS: '', SETTINGS_KEY: 'plain-key  ' });
    expect(mod.config.settingsKey).toBe('plain-key  ');
  });
});

describe('config — auth method requirement (standard mode)', () => {
  it('throws when no auth method is configured (local off, no OIDC)', async () => {
    await expect(
      loadConfig({ NODE_ENV: 'test', AUTH_BYPASS: '', LOCAL_AUTH: '0', OIDC_PROVIDERS: '' }),
    ).rejects.toThrow(/No authentication method is configured/);
  });

  it('resolves once a local method is enabled', async () => {
    const mod = await loadConfig({ NODE_ENV: 'test', AUTH_BYPASS: '', LOCAL_AUTH: '1', OIDC_PROVIDERS: '' });
    expect(mod.config.localAuth).toBe(true);
  });
});

describe('config — BEHIND_TLS derivation', () => {
  // AUTH_BYPASS is neutralized in the non-prod cases that omit a SESSION_SECRET so the standard-mode
  // boot doesn't trip another guard; LOCAL_AUTH defaults on so there's always a way in. The prod
  // cases supply SESSION_SECRET (required in prod) and neutralize AUTH_BYPASS (refused in prod).
  it('absent + prod → true (default-on so prod stays byte-identical)', async () => {
    const mod = await loadConfig({ NODE_ENV: 'production', SESSION_SECRET: 's', AUTH_BYPASS: '', OIDC_PROVIDERS: '' });
    expect(mod.config.behindTls).toBe(true);
  });

  it('absent + non-prod → false', async () => {
    const mod = await loadConfig({ NODE_ENV: 'test', AUTH_BYPASS: '' });
    expect(mod.config.behindTls).toBe(false);
  });

  it('explicit false under prod → false (the prod plain-HTTP topology)', async () => {
    const mod = await loadConfig({
      NODE_ENV: 'production',
      SESSION_SECRET: 's',
      AUTH_BYPASS: '',
      OIDC_PROVIDERS: '',
      BEHIND_TLS: 'false',
    });
    expect(mod.config.behindTls).toBe(false);
  });

  it('explicit true under non-prod → true', async () => {
    const mod = await loadConfig({ NODE_ENV: 'test', AUTH_BYPASS: '', BEHIND_TLS: 'true' });
    expect(mod.config.behindTls).toBe(true);
  });

  it('TRUTHY variants (1/yes/on) coerce to true; blank falls back to isProd', async () => {
    for (const v of ['1', 'yes', 'on']) {
      vi.unstubAllEnvs();
      expect((await loadConfig({ NODE_ENV: 'test', AUTH_BYPASS: '', BEHIND_TLS: v })).config.behindTls).toBe(true);
    }
    // Blank string is not "set" → falls back to isProd (false here).
    vi.unstubAllEnvs();
    expect((await loadConfig({ NODE_ENV: 'test', AUTH_BYPASS: '', BEHIND_TLS: '' })).config.behindTls).toBe(false);
  });
});

describe('config — INSTANCE_BADGE (display-only tab badge)', () => {
  // AUTH_BYPASS is neutralized so the standard-mode boot doesn't trip another guard (LOCAL_AUTH
  // defaults on, so there's always a way in). instanceBadge is optional: present only when a
  // non-empty value is set, omitted (undefined) otherwise — matching exactOptionalPropertyTypes.
  it('absent → instanceBadge undefined (prod, zero behavior change)', async () => {
    vi.stubEnv('INSTANCE_BADGE', undefined as unknown as string);
    const mod = await loadConfig({ NODE_ENV: 'test', AUTH_BYPASS: '' });
    expect(mod.config.instanceBadge).toBeUndefined();
  });

  it('empty / whitespace-only → undefined (unset)', async () => {
    expect((await loadConfig({ NODE_ENV: 'test', AUTH_BYPASS: '', INSTANCE_BADGE: '' })).config.instanceBadge).toBeUndefined();
    vi.unstubAllEnvs();
    expect(
      (await loadConfig({ NODE_ENV: 'test', AUTH_BYPASS: '', INSTANCE_BADGE: '   ' })).config.instanceBadge,
    ).toBeUndefined();
  });

  it('non-empty value is trimmed and set', async () => {
    expect((await loadConfig({ NODE_ENV: 'test', AUTH_BYPASS: '', INSTANCE_BADGE: 'dev' })).config.instanceBadge).toBe('dev');
    vi.unstubAllEnvs();
    expect(
      (await loadConfig({ NODE_ENV: 'test', AUTH_BYPASS: '', INSTANCE_BADGE: '  dev  ' })).config.instanceBadge,
    ).toBe('dev');
  });
});

describe('config — env coercion', () => {
  it('rejects a non-numeric PORT', async () => {
    await expect(loadConfig({ PORT: '60abc' })).rejects.toThrow(/Invalid environment config/);
  });

  it('defaults LOCAL_AUTH to true when unset and disables it for falsey strings', async () => {
    // AUTH_BYPASS sidesteps the standard-mode no-auth-method throw so localAuth is the only var under test.
    expect((await loadConfig({ AUTH_BYPASS: '1', NODE_ENV: 'test' })).config.localAuth).toBe(true);
    vi.unstubAllEnvs();
    expect((await loadConfig({ AUTH_BYPASS: '1', NODE_ENV: 'test', LOCAL_AUTH: '0' })).config.localAuth).toBe(false);
    vi.unstubAllEnvs();
    expect((await loadConfig({ AUTH_BYPASS: '1', NODE_ENV: 'test', LOCAL_AUTH: 'false' })).config.localAuth).toBe(
      false,
    );
  });
});
