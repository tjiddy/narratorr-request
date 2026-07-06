import { createCipheriv, createDecipheriv, randomBytes, hkdfSync } from 'node:crypto';

/**
 * Symmetric encryption for connector secrets stored in the DB (narratorr API key,
 * SMTP password, ntfy token). AES-256-GCM with a per-value random IV; the stored
 * string is `enc:v1:<base64(iv|tag|ciphertext)>`.
 *
 * The key is derived (HKDF-SHA256) from an explicit `SETTINGS_KEY` if set, else the
 * existing `SESSION_SECRET` — so no new env var is mandatory, with SETTINGS_KEY as an
 * opt-in to decouple connector secrets from the session signing key. Decryption fails
 * SOFT (returns null) so a key change degrades a connector to "unconfigured" rather
 * than crashing boot.
 */
const PREFIX = 'enc:v1:';
const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

/** Derive a stable 32-byte key from whichever source string is configured. */
export function deriveSettingsKey(opts: { settingsKey?: string | undefined; sessionSecret: string }): Buffer {
  const source = opts.settingsKey?.trim() || opts.sessionSecret;
  // The HKDF `info` is a frozen key-derivation domain separator, NOT a display name. It
  // tracks the app name only by coincidence; changing it re-derives the key and orphans
  // every stored secret. Realigned to `narratorr-requests` during the pre-1.0 DB wipe — from
  // here it is fixed. Do NOT touch it in a future rename; rotate via `:v2` as a deliberate,
  // migrated key change only.
  const derived = hkdfSync('sha256', source, new Uint8Array(0), 'narratorr-requests:settings:v1', 32);
  return Buffer.from(derived);
}

export class SecretCodec {
  constructor(private readonly key: Buffer) {}

  isEncrypted(value: string): boolean {
    return value.startsWith(PREFIX);
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv(ALGO, this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return PREFIX + Buffer.concat([iv, tag, ct]).toString('base64');
  }

  /** Decrypt an `enc:v1:` blob. Returns null for non-blobs or any failure (wrong key,
   *  tampered ciphertext) — callers treat null as "secret unavailable". */
  decrypt(value: string): string | null {
    if (!this.isEncrypted(value)) return null;
    try {
      const buf = Buffer.from(value.slice(PREFIX.length), 'base64');
      const iv = buf.subarray(0, IV_LEN);
      const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
      const ct = buf.subarray(IV_LEN + TAG_LEN);
      const decipher = createDecipheriv(ALGO, this.key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    } catch {
      return null;
    }
  }
}
