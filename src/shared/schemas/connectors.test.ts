import { describe, it, expect } from 'vitest';
import {
  connectorSettingsDtoSchema,
  isKnownNotifierDto,
  notifierDtoSchema,
  resolvedKindleSenderSchema,
  storedConnectorsSchema,
  storedKindleSenderSchema,
  storedNotifierSchema,
  testConnectorBodySchema,
  testConnectorResultSchema,
  updateConnectorSettingsBodySchema,
  createNotifierBodySchema,
  notifierTestBodySchema,
  DEFAULT_QUOTA_LIMIT_MAX,
} from './connectors';

// `httpUrl` is a private constant; its behavior is exercised through the exported
// `updateConnectorSettingsBodySchema` (the PUT body) — the same way the API contract is
// reached through its public surface. The notification-channel field validators moved to
// the notifier registry (see notifier-registry.test.ts).
const parse = (body: unknown) => updateConnectorSettingsBodySchema.parse(body);
const accepts = (body: unknown) => updateConnectorSettingsBodySchema.safeParse(body).success;
const issues = (body: unknown) => updateConnectorSettingsBodySchema.safeParse(body).error?.issues ?? [];

describe('httpUrl (via publicUrl)', () => {
  it('strips trailing slashes and trims', () => {
    expect(parse({ publicUrl: 'https://x.com/' }).publicUrl).toBe('https://x.com');
    expect(parse({ publicUrl: '  https://x.com///  ' }).publicUrl).toBe('https://x.com');
  });

  it('rejects non-http(s) schemes and scheme-less values', () => {
    expect(accepts({ publicUrl: 'ftp://x.com' })).toBe(false);
    expect(accepts({ publicUrl: 'x.com' })).toBe(false);
  });
});

describe('updateConnectorSettingsBodySchema — narratorr + publicUrl only', () => {
  const narr = (over: Record<string, unknown>) => ({
    narratorr: { url: 'http://narratorr:3000', ...over },
  });

  it('accepts a narratorr object with url + apiKey', () => {
    const parsed = parse({ narratorr: { url: 'http://books.example.com:443/lib', apiKey: 'k' } });
    expect(parsed.narratorr).toEqual({ url: 'http://books.example.com:443/lib', apiKey: 'k' });
  });

  it('accepts plain, private, IPv6-literal and subpath URLs; strips the trailing slash', () => {
    for (const url of [
      'http://host:3000',
      'http://192.168.1.10:3000',
      'http://[::1]:3000',
      'https://localhost',
      'http://host:3000/lib',
    ]) {
      expect(parse(narr({ url, apiKey: 'k' })).narratorr?.url).toBe(url);
    }
    expect(parse(narr({ url: 'http://host:3000/', apiKey: 'k' })).narratorr?.url).toBe('http://host:3000');
  });

  it('rejects a scheme-less value and a bare http:// with no host', () => {
    expect(accepts(narr({ url: 'narratorr:3000', apiKey: 'k' }))).toBe(false);
    expect(accepts(narr({ url: 'http://', apiKey: 'k' }))).toBe(false);
  });

  it('apiKey is optional (omit-to-keep still parses)', () => {
    expect(accepts(narr({}))).toBe(true);
    expect(parse(narr({})).narratorr).toEqual({ url: 'http://narratorr:3000' });
  });

  it('is .strict() at the top level — the old ntfy/email/webhook slots are now rejected', () => {
    expect(issues({ ntfy: { url: 'https://ntfy.sh', topic: 't' } })[0]?.code).toBe('unrecognized_keys');
    expect(accepts({ email: { host: 'h', from: 'f@x', to: 't@x' } })).toBe(false);
    expect(accepts({ webhook: { url: 'https://x/hook' } })).toBe(false);
    expect(accepts({ bogus: 1 })).toBe(false);
  });
});

describe('updateConnectorSettingsBodySchema — defaultQuota (mode-first)', () => {
  const quota = (q: unknown) => parse({ defaultQuota: q }).defaultQuota;

  it('accepts an unlimited mode (no limit) + an allowed window', () => {
    expect(quota({ mode: 'unlimited', windowDays: 30 })).toEqual({ mode: 'unlimited', windowDays: 30 });
    expect(quota({ mode: 'unlimited', windowDays: 1 })).toEqual({ mode: 'unlimited', windowDays: 1 });
  });

  it('accepts a limited mode with a positive int limit + an allowed window', () => {
    expect(quota({ mode: 'limited', limit: 3, windowDays: 7 })).toEqual({ mode: 'limited', limit: 3, windowDays: 7 });
    expect(quota({ mode: 'limited', limit: 1, windowDays: 1 })).toEqual({ mode: 'limited', limit: 1, windowDays: 1 });
    expect(quota({ mode: 'limited', limit: 50, windowDays: 30 })).toEqual({ mode: 'limited', limit: 50, windowDays: 30 });
  });

  it('rejects a limit on the unlimited mode', () => {
    expect(accepts({ defaultQuota: { mode: 'unlimited', limit: 5, windowDays: 30 } })).toBe(false);
  });

  it('rejects a missing / 0 / negative / non-integer limit on the limited mode', () => {
    expect(accepts({ defaultQuota: { mode: 'limited', windowDays: 30 } })).toBe(false);
    expect(accepts({ defaultQuota: { mode: 'limited', limit: 0, windowDays: 30 } })).toBe(false);
    expect(accepts({ defaultQuota: { mode: 'limited', limit: -1, windowDays: 30 } })).toBe(false);
    expect(accepts({ defaultQuota: { mode: 'limited', limit: 3.5, windowDays: 30 } })).toBe(false);
  });

  it('rejects an unknown mode and an out-of-set windowDays on either mode', () => {
    expect(accepts({ defaultQuota: { mode: 'blocked', windowDays: 30 } })).toBe(false); // blocked is per-user only
    for (const bad of [5, 31, 0, -7, 14, 365]) {
      expect(accepts({ defaultQuota: { mode: 'unlimited', windowDays: bad } })).toBe(false);
      expect(accepts({ defaultQuota: { mode: 'limited', limit: 3, windowDays: bad } })).toBe(false);
    }
  });

  it('windowDays is required on both modes; the whole object stays optional', () => {
    expect(accepts({ defaultQuota: { mode: 'limited', limit: 3 } })).toBe(false); // windowDays now required
    expect(accepts({ defaultQuota: { mode: 'unlimited' } })).toBe(false);
    expect(accepts({})).toBe(true); // defaultQuota omitted entirely
  });

  it('caps the limit at DEFAULT_QUOTA_LIMIT_MAX (accepts the boundary, rejects past it)', () => {
    expect(quota({ mode: 'limited', limit: DEFAULT_QUOTA_LIMIT_MAX, windowDays: 30 })).toEqual({ mode: 'limited', limit: DEFAULT_QUOTA_LIMIT_MAX, windowDays: 30 });
    expect(accepts({ defaultQuota: { mode: 'limited', limit: DEFAULT_QUOTA_LIMIT_MAX + 1, windowDays: 30 } })).toBe(false);
    // A wildly oversized value (the pasted-digit-string tail) is rejected, not silently round-tripped.
    expect(accepts({ defaultQuota: { mode: 'limited', limit: 10 ** 12, windowDays: 30 } })).toBe(false);
  });
});

describe('testConnectorBodySchema — narratorr only', () => {
  it('accepts a narratorr candidate', () => {
    expect(testConnectorBodySchema.parse({ channel: 'narratorr' }).channel).toBe('narratorr');
    expect(
      testConnectorBodySchema.safeParse({ channel: 'narratorr', narratorr: { url: 'http://n:3000' } }).success,
    ).toBe(true);
  });

  it('rejects a non-narratorr channel and unknown top-level keys (.strict)', () => {
    expect(testConnectorBodySchema.safeParse({ channel: 'ntfy' }).success).toBe(false);
    expect(testConnectorBodySchema.safeParse({ channel: 'narratorr', extra: 1 }).success).toBe(false);
  });
});

describe('testConnectorResultSchema', () => {
  it('accepts { success, message } and rejects wrong types', () => {
    expect(testConnectorResultSchema.parse({ success: true, message: 'ok' })).toEqual({ success: true, message: 'ok' });
    expect(testConnectorResultSchema.safeParse({ success: 'yes', message: 'ok' }).success).toBe(false);
  });
});

describe('createNotifierBodySchema / notifierTestBodySchema', () => {
  const base = { name: 'My phone', type: 'ntfy', events: ['request.created'], config: {} };

  it('accepts a valid envelope (config validated server-side, opaque here)', () => {
    expect(createNotifierBodySchema.safeParse(base).success).toBe(true);
  });

  it('rejects an out-of-registry type, empty events, whitespace-only name, and unknown keys', () => {
    expect(createNotifierBodySchema.safeParse({ ...base, type: 'apprise' }).success).toBe(false);
    expect(createNotifierBodySchema.safeParse({ ...base, events: [] }).success).toBe(false);
    expect(createNotifierBodySchema.safeParse({ ...base, name: '   ' }).success).toBe(false);
    expect(createNotifierBodySchema.safeParse({ ...base, bogus: 1 }).success).toBe(false);
  });

  it('rejects an unknown event key in events', () => {
    expect(createNotifierBodySchema.safeParse({ ...base, events: ['request.bogus'] }).success).toBe(false);
  });

  it('accepts request.failed as a known event key (#60)', () => {
    expect(createNotifierBodySchema.safeParse({ ...base, events: ['request.failed'] }).success).toBe(true);
  });

  it('notifier test body carries type + config, optional id + publicUrl', () => {
    expect(notifierTestBodySchema.parse({ type: 'webhook', config: { url: 'https://x/h' }, id: 'nf_1', publicUrl: 'https://a.com' })).toMatchObject({
      type: 'webhook',
      id: 'nf_1',
    });
    expect(notifierTestBodySchema.safeParse({ type: 'webhook', config: {} }).success).toBe(true);
  });

  it('notifier test body event: accepts the known events, defaults to request.created, rejects unknown', () => {
    expect(notifierTestBodySchema.parse({ type: 'ntfy', config: {}, event: 'user.pending' }).event).toBe('user.pending');
    expect(notifierTestBodySchema.parse({ type: 'ntfy', config: {}, event: 'request.created' }).event).toBe('request.created');
    // Omitted → legacy request.created sample, preserving today's probe.
    expect(notifierTestBodySchema.parse({ type: 'ntfy', config: {} }).event).toBe('request.created');
    // request.failed is now a known event (#60); a still-unknown key is rejected.
    expect(notifierTestBodySchema.parse({ type: 'ntfy', config: {}, event: 'request.failed' }).event).toBe('request.failed');
    expect(notifierTestBodySchema.safeParse({ type: 'ntfy', config: {}, event: 'request.bogus' }).success).toBe(false);
  });
});

describe('storedConnectorsSchema — kindleSender containment (#143)', () => {
  const blob = (over: Record<string, unknown> = {}) => ({
    publicUrl: null,
    narratorr: { url: 'https://n:3000', apiKey: 'enc:v1:abc' },
    notifiers: [{ id: 'nf_1', name: 'Phone', type: 'ntfy', events: ['request.created'], config: { topic: 't' } }],
    ...over,
  });

  it('parses a PRE-FEATURE blob (no kindleSender key) with the siblings intact', () => {
    const parsed = storedConnectorsSchema.parse(blob());
    expect(parsed.narratorr).toEqual({ url: 'https://n:3000', apiKey: 'enc:v1:abc' });
    expect(parsed.notifiers).toHaveLength(1);
    expect(parsed.kindleSender ?? null).toBeNull();
  });

  it('round-trips a healthy selection', () => {
    expect(storedConnectorsSchema.parse(blob({ kindleSender: { notifierId: 'nf_1', confirmedFrom: 'Bot@Ex.com' } })).kindleSender)
      .toEqual({ notifierId: 'nf_1', confirmedFrom: 'Bot@Ex.com' });
  });

  // The member carries its own `.catch(null)` so a malformed value degrades ROW-LOCALLY. Without
  // it the whole envelope fails, and `connectorsFrom()` resets the blob to EMPTY — discarding the
  // encrypted narratorr key. Assert the SIBLINGS survive, not just that the member is null.
  it.each([
    ['a non-object', 42],
    ['a wrong-typed member', { notifierId: 42 }],
    ['a missing member', {}],
  ])('contains %s to null while narratorr + notifiers survive', (_label, kindleSender) => {
    const parsed = storedConnectorsSchema.safeParse(blob({ kindleSender }));
    expect(parsed.success).toBe(true);
    expect(parsed.data?.kindleSender ?? null).toBeNull();
    expect(parsed.data?.narratorr).toEqual({ url: 'https://n:3000', apiKey: 'enc:v1:abc' });
    expect(parsed.data?.notifiers).toHaveLength(1);
  });

  it('accepts an explicit null (a cleared selection)', () => {
    expect(storedConnectorsSchema.parse(blob({ kindleSender: null })).kindleSender).toBeNull();
  });

  // Both boundaries DERIVE from `storedKindleSenderSchema`, so a constraint tightened there must
  // reach storage and the wire together. Restating the pair in the resolved schema is the drift
  // shape this pins: with two hand-copied field lists, a value can be valid at one layer and
  // rejected (or silently stripped) at the other.
  it('the stored member and the resolved DTO share ONE pair contract', () => {
    const pairKeys = Object.keys(storedKindleSenderSchema.shape).sort();
    expect(pairKeys).toEqual(['confirmedFrom', 'notifierId']);
    // The resolved schema is the pair PLUS the read-time fields — nothing dropped, nothing renamed.
    expect(Object.keys(resolvedKindleSenderSchema.shape).sort()).toEqual(
      [...pairKeys, 'currentFrom', 'status'].sort(),
    );
    // …and the shared members are the very same schema objects, not look-alike copies.
    expect(resolvedKindleSenderSchema.shape.notifierId).toBe(storedKindleSenderSchema.shape.notifierId);
    expect(resolvedKindleSenderSchema.shape.confirmedFrom).toBe(storedKindleSenderSchema.shape.confirmedFrom);
  });
});

describe('updateConnectorSettingsBodySchema — kindleSender (#143)', () => {
  it('accepts an id-only selection, an explicit null, and omission', () => {
    expect(parse({ kindleSender: { notifierId: 'nf_1' } }).kindleSender).toEqual({ notifierId: 'nf_1' });
    expect(parse({ kindleSender: null }).kindleSender).toBeNull();
    expect(parse({}).kindleSender).toBeUndefined();
  });

  // The inner object is `.strict()` so a client can never SUPPLY the confirmation — the server
  // always derives it from the notifier's live `from`, which is what makes it unspoofable.
  it('rejects a client-supplied confirmedFrom (or any other extra inner key)', () => {
    expect(accepts({ kindleSender: { notifierId: 'nf_1', confirmedFrom: 'x@y.com' } })).toBe(false);
    expect(accepts({ kindleSender: { notifierId: 'nf_1', bogus: 1 } })).toBe(false);
  });

  it('rejects an empty notifierId and a non-object selection', () => {
    expect(accepts({ kindleSender: { notifierId: '' } })).toBe(false);
    expect(accepts({ kindleSender: 'nf_1' })).toBe(false);
  });
});

describe('updateConnectorSettingsBodySchema — ebooksEnabled (#144)', () => {
  it('accepts true, false, and omission (omit-to-keep); there is no null clear', () => {
    expect(parse({ ebooksEnabled: true }).ebooksEnabled).toBe(true);
    // The load-bearing half: an explicit `false` must survive as `false`, distinguishable from
    // the omitted case below. A write path branching on truthiness would collapse the two.
    expect(parse({ ebooksEnabled: false }).ebooksEnabled).toBe(false);
    expect(parse({}).ebooksEnabled).toBeUndefined();
    expect(accepts({ ebooksEnabled: null })).toBe(false);
  });

  it('rejects a non-boolean (no string/number coercion)', () => {
    for (const bad of ['true', 'false', 1, 0, {}]) expect(accepts({ ebooksEnabled: bad })).toBe(false);
  });
});

describe('storedNotifierSchema — type-lenient persistence boundary', () => {
  it('parses a row whose type is NOT in the registry (round-trips, type: string)', () => {
    const row = { id: 'nf_x', name: 'Legacy', type: 'apprise', events: ['user.pending'], config: { token: 'enc:v1:abc' } };
    const parsed = storedNotifierSchema.parse(row);
    expect(parsed.type).toBe('apprise');
    expect(parsed.config).toEqual({ token: 'enc:v1:abc' });
  });
});

describe('notifierDtoSchema — discriminated known | unknown', () => {
  it('accepts a known (masked) notifier DTO', () => {
    const dto = {
      id: 'nf_1',
      name: 'Phone',
      type: 'ntfy',
      events: ['request.created'],
      config: { url: 'https://ntfy.sh', topic: 't', hasToken: true, priority: null },
    };
    expect(notifierDtoSchema.safeParse(dto).success).toBe(true);
  });

  it('accepts a webhook DTO masked to a host hint (no plaintext url)', () => {
    const dto = { id: 'nf_2', name: 'Discord', type: 'webhook', events: ['request.created'], config: { hasUrl: true, urlHint: 'discord.com/…' } };
    expect(notifierDtoSchema.safeParse(dto).success).toBe(true);
  });

  it('accepts an unknown-type DTO (deletable, no config)', () => {
    const dto = { id: 'nf_3', name: 'Legacy', type: 'apprise', events: ['user.pending'], unknown: true };
    expect(notifierDtoSchema.safeParse(dto).success).toBe(true);
  });
});

describe('isKnownNotifierDto — the one owner of the DTO known/degraded decision', () => {
  const known = { id: 'nf_1', name: 'Mail', type: 'email' as const, events: [], config: { from: 'a@ex.com' } };
  const degraded = { id: 'nf_2', name: 'Broken', type: 'email', events: [], unknown: true as const };

  it('accepts a known row and rejects a degraded one', () => {
    expect(isKnownNotifierDto(known)).toBe(true);
    expect(isKnownNotifierDto(degraded)).toBe(false);
  });

  // The whole point of one owner: the notifier list's affordances and the Kindle picker's
  // eligibility must agree about the SAME row. A degraded row carries a known-looking raw
  // `type`, so a type-only check would classify it differently on each surface.
  it('classifies a degraded row by its `unknown` marker, not its raw type', () => {
    expect(degraded.type).toBe('email'); // raw type alone would say "known"
    expect(isKnownNotifierDto(degraded)).toBe(false);
  });
});

describe('connectorSettingsDtoSchema', () => {
  it('accepts a representative masked payload with a notifier list', () => {
    const dto = {
      publicUrl: 'https://requests.example.com',
      narratorr: { url: 'https://narratorr.example.com/lib', hasApiKey: true },
      notifiers: [
        { id: 'nf_1', name: 'Phone', type: 'ntfy', events: ['request.created'], config: { url: 'https://ntfy.sh', topic: 't', hasToken: false, priority: null } },
        { id: 'nf_2', name: 'Legacy', type: 'apprise', events: ['user.pending'], unknown: true },
      ],
      defaultQuota: { mode: 'limited', limit: 10, windowDays: 30 },
      requesterEmailWarning: false,
      kindleSender: null,
      ebooksEnabled: false,
    };
    expect(connectorSettingsDtoSchema.safeParse(dto).success).toBe(true);
  });

  it('accepts empty notifiers + null connections + an unlimited default', () => {
    const dto = {
      publicUrl: null,
      narratorr: null,
      notifiers: [],
      defaultQuota: { mode: 'unlimited', windowDays: 30 },
      requesterEmailWarning: false,
      kindleSender: null,
      ebooksEnabled: true,
    };
    expect(connectorSettingsDtoSchema.parse(dto)).toEqual(dto);
  });

  // The response object is non-`.strict()`, so a resolved kindleSender the mapper emits but the
  // schema omitted would be SILENTLY stripped off the wire. Pin that it survives serialization.
  it('carries the resolved kindleSender through, and rejects an unknown status', () => {
    const dto = (kindleSender: unknown) => ({
      publicUrl: null,
      narratorr: null,
      notifiers: [],
      defaultQuota: { mode: 'unlimited' as const, windowDays: 30 },
      requesterEmailWarning: false,
      kindleSender,
      ebooksEnabled: false,
    });
    const resolved = { notifierId: 'nf_1', confirmedFrom: 'Bot@Ex.com', status: 'sender-changed', currentFrom: 'new@ex.com' };
    expect(connectorSettingsDtoSchema.parse(dto(resolved)).kindleSender).toEqual(resolved);
    for (const status of ['ok', 'notifier-missing', 'not-email', 'config-unusable', 'from-unparseable', 'sender-changed']) {
      expect(connectorSettingsDtoSchema.safeParse(dto({ ...resolved, status })).success, status).toBe(true);
    }
    expect(connectorSettingsDtoSchema.safeParse(dto({ ...resolved, status: 'bogus' })).success).toBe(false);
    expect(connectorSettingsDtoSchema.safeParse(dto({ notifierId: 'nf_1', confirmedFrom: 'x@y.com' })).success).toBe(false);
  });

  // Same non-`.strict()` trap as kindleSender above (issue #144): a field added to the
  // hand-written `ConnectorSettingsDto` interface but FORGOTTEN in this schema compiles fine and
  // is then silently stripped off the wire, so the Settings page reads the toggle as absent. This
  // must be asserted on the PARSED OUTPUT — `safeParse().success` stays true either way.
  it('retains ebooksEnabled through the response schema (both true and false)', () => {
    const dto = (ebooksEnabled: unknown) => ({
      publicUrl: null,
      narratorr: null,
      notifiers: [],
      defaultQuota: { mode: 'unlimited' as const, windowDays: 30 },
      requesterEmailWarning: false,
      kindleSender: null,
      ebooksEnabled,
    });
    expect(connectorSettingsDtoSchema.parse(dto(true)).ebooksEnabled).toBe(true);
    expect(connectorSettingsDtoSchema.parse(dto(false)).ebooksEnabled).toBe(false);
    // Required, and a boolean — not coerced from a truthy/falsy stand-in.
    expect(connectorSettingsDtoSchema.safeParse(dto(undefined)).success).toBe(false);
    expect(connectorSettingsDtoSchema.safeParse(dto('true')).success).toBe(false);
    expect(connectorSettingsDtoSchema.safeParse(dto(1)).success).toBe(false);
  });

  it('requires defaultQuota in the masked DTO', () => {
    expect(connectorSettingsDtoSchema.safeParse({ publicUrl: null, narratorr: null, notifiers: [] }).success).toBe(false);
  });

  it('rejects an unsupported defaultQuota.windowDays in the masked DTO (constraint holds on the GET/response side too)', () => {
    const dto = (windowDays: number) => ({
      publicUrl: null,
      narratorr: null,
      notifiers: [],
      defaultQuota: { mode: 'limited', limit: 10, windowDays },
      requesterEmailWarning: false,
      kindleSender: null,
      ebooksEnabled: false,
    });
    for (const allowed of [1, 7, 30]) {
      expect(connectorSettingsDtoSchema.safeParse(dto(allowed)).success).toBe(true);
    }
    for (const bad of [5, 31, 0, -7, 14]) {
      expect(connectorSettingsDtoSchema.safeParse(dto(bad)).success).toBe(false);
    }
  });
});
