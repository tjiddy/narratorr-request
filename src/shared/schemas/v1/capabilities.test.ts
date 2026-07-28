import { describe, it, expect } from 'vitest';
import { v1CapabilitiesSchema } from './capabilities.js';

describe('v1CapabilitiesSchema (vendored, consumer-lenient)', () => {
  it('parses the enabled and disabled bodies, retaining the boolean', () => {
    expect(v1CapabilitiesSchema.parse({ companionEpub: { enabled: true } }).companionEpub.enabled).toBe(true);
    expect(v1CapabilitiesSchema.parse({ companionEpub: { enabled: false } }).companionEpub.enabled).toBe(false);
  });

  it('tolerates unknown sibling keys at BOTH levels (a future second capability must not break us)', () => {
    const parsed = v1CapabilitiesSchema.parse({
      companionEpub: { enabled: true, somethingNarratorrAddedLater: 1 },
      someOtherCapability: { enabled: false },
    });
    expect(parsed).toEqual({ companionEpub: { enabled: true } });
  });

  it('rejects a body missing the capability, missing the flag, or carrying a non-boolean flag', () => {
    // `companionEpub.enabled` is the ENTIRE payload, so a body without it is contract
    // drift → CONTRACT_MISMATCH, which the probe treats as transient. `404` (no such
    // route) is the only "unsupported" signal.
    expect(v1CapabilitiesSchema.safeParse({}).success).toBe(false);
    expect(v1CapabilitiesSchema.safeParse({ companionEpub: {} }).success).toBe(false);
    expect(v1CapabilitiesSchema.safeParse({ companionEpub: { enabled: 'yes' } }).success).toBe(false);
  });
});
