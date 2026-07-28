import { describe, it, expect } from 'vitest';
import { featuresDtoSchema, FEATURES_OFF } from './features.js';

// The derived feature payload (issue #144). The INVARIANT chain
// (`!ebooksEnabled ⇒ !kindleDeliveryAvailable ⇒ kindleSenderEmail === null`) is asserted where
// it is derived — `deriveFeatures` in `features.route.test.ts` — not here: this schema is the
// wire shape, and encoding the chain as a refinement would turn a server-side derivation bug into
// a 500 on the response serializer rather than a caught test.

const dto = (over: Record<string, unknown> = {}) => ({
  ebooksEnabled: false,
  kindleDeliveryAvailable: false,
  kindleSenderEmail: null,
  ...over,
});

describe('featuresDtoSchema', () => {
  it('accepts the three-field payload in both kindleSenderEmail shapes', () => {
    expect(featuresDtoSchema.parse(dto())).toEqual(FEATURES_OFF);
    const on = dto({ ebooksEnabled: true, kindleDeliveryAvailable: true, kindleSenderEmail: 'bot@ex.com' });
    expect(featuresDtoSchema.parse(on)).toEqual(on);
  });

  it('requires all three fields (a dropped one is a contract change, not a default)', () => {
    for (const key of ['ebooksEnabled', 'kindleDeliveryAvailable', 'kindleSenderEmail']) {
      const partial = dto();
      delete (partial as Record<string, unknown>)[key];
      expect(featuresDtoSchema.safeParse(partial).success, key).toBe(false);
    }
  });

  it('rejects wrong types — no coercion of a truthy string/number into a flag', () => {
    expect(featuresDtoSchema.safeParse(dto({ ebooksEnabled: 'true' })).success).toBe(false);
    expect(featuresDtoSchema.safeParse(dto({ kindleDeliveryAvailable: 1 })).success).toBe(false);
    expect(featuresDtoSchema.safeParse(dto({ kindleSenderEmail: 42 })).success).toBe(false);
    // `undefined` is not the same as `null` for the address — the wire shape is explicit.
    expect(featuresDtoSchema.safeParse(dto({ kindleSenderEmail: undefined })).success).toBe(false);
  });

  it('FEATURES_OFF is a valid payload with every flag off', () => {
    // The fail-closed constant the route degrades to — it must satisfy its own response schema,
    // or a degraded read would 500 on serialization instead of answering 200.
    expect(featuresDtoSchema.parse(FEATURES_OFF)).toEqual(FEATURES_OFF);
    expect(FEATURES_OFF).toEqual({ ebooksEnabled: false, kindleDeliveryAvailable: false, kindleSenderEmail: null });
  });
});
