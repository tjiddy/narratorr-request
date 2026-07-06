import { describe, it, expect } from 'vitest';
import { SecretCodec, deriveSettingsKey } from './secret-codec.js';

const codec = new SecretCodec(deriveSettingsKey({ sessionSecret: 'test-session-secret' }));

describe('SecretCodec', () => {
  it('round-trips a secret and hides the plaintext', () => {
    const ct = codec.encrypt('hunter2');
    expect(ct).not.toContain('hunter2');
    expect(codec.isEncrypted(ct)).toBe(true);
    expect(codec.decrypt(ct)).toBe('hunter2');
  });

  it('uses a fresh IV each call (ciphertexts differ, both decrypt)', () => {
    const a = codec.encrypt('same');
    const b = codec.encrypt('same');
    expect(a).not.toBe(b);
    expect(codec.decrypt(a)).toBe('same');
    expect(codec.decrypt(b)).toBe('same');
  });

  it('decrypt returns null for non-blobs (plaintext)', () => {
    expect(codec.decrypt('not-encrypted')).toBeNull();
  });

  it('decrypt fails soft (null, never throws) on a malformed or tampered blob', () => {
    expect(codec.decrypt('enc:v1:not-valid-base64-@@@')).toBeNull();
    expect(codec.decrypt('enc:v1:' + Buffer.from('too-short').toString('base64'))).toBeNull();
    const ct = codec.encrypt('secret');
    const tampered = ct.slice(0, -4) + (ct.endsWith('AAAA') ? 'BBBB' : 'AAAA'); // flip the auth tag/ciphertext tail
    expect(codec.decrypt(tampered)).toBeNull();
  });

  it('decrypt fails soft (null) with the wrong key', () => {
    const other = new SecretCodec(deriveSettingsKey({ sessionSecret: 'different-secret' }));
    expect(other.decrypt(codec.encrypt('secret'))).toBeNull();
  });

  it('SETTINGS_KEY overrides the SESSION_SECRET-derived key', () => {
    const explicit = deriveSettingsKey({ settingsKey: 'explicit-key', sessionSecret: 's' });
    const derived = deriveSettingsKey({ sessionSecret: 's' });
    expect(explicit.equals(derived)).toBe(false);
  });
});
