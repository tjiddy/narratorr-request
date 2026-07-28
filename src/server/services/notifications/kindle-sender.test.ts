import { describe, it, expect } from 'vitest';
import { parseSingleMailbox, confirmSenderMailbox, resolveKindleSender } from './kindle-sender.js';
import type { RuntimeNotifier } from './types.js';

// A decrypted (runtime) email notifier — the exact shape getNotificationsConfig() produces and
// selectEmailSource() consumes, so "usable" here is the same predicate the send path uses.
const emailNotifier = (id: string, over: Record<string, unknown> = {}): RuntimeNotifier => ({
  id,
  name: `Mail ${id}`,
  type: 'email',
  events: ['request.created'],
  config: {
    host: 'smtp.example.com',
    port: 587,
    secure: false,
    user: 'u',
    pass: 'p',
    from: 'bot@ex.com',
    to: 'admin@ex.com',
    ...over,
  },
});

describe('parseSingleMailbox — structural parse + validity gate', () => {
  it('accepts a bare mailbox, strips the display name, and preserves case verbatim', () => {
    expect(parseSingleMailbox('bot@ex.com')).toBe('bot@ex.com');
    expect(parseSingleMailbox('Narratorr <Bot@Ex.com>')).toBe('Bot@Ex.com');
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseSingleMailbox('  bot@ex.com  ')).toBe('bot@ex.com');
  });

  it.each([
    ['an empty string', ''],
    ['whitespace only', '   '],
    ['a bare non-address token', 'no-address-here'],
    ['two addresses', 'a@x.com, b@y.com'],
    ['group syntax', 'Undisclosed:a@x.com;'],
  ])('rejects %s (structural gate)', (_label, from) => {
    expect(parseSingleMailbox(from)).toBeNull();
  });

  // The parser is a SPLITTER, not a validator: with an `@` present it hands back the raw text as
  // the address, so each of these passes a non-empty check. `hasDeliverableContact` is the gate
  // that rejects them — drop it from parseSingleMailbox and every case here turns green.
  it.each([
    ['a missing domain', 'a@'],
    ['a missing local part', '@example.com'],
    ['a dotless domain', 'a@b'],
    ['a double @', 'a@b@c'],
    ['an over-254-character address', `${'a'.repeat(250)}@ex.com`],
  ])('rejects %s (validity gate)', (_label, from) => {
    expect(parseSingleMailbox(from)).toBeNull();
  });
});

describe('resolveKindleSender', () => {
  it('returns null for a null selection (nothing chosen)', () => {
    expect(resolveKindleSender(null, [emailNotifier('nf_1')])).toBeNull();
  });

  it('resolves ok with currentFrom equal to the confirmed mailbox', () => {
    expect(
      resolveKindleSender({ notifierId: 'nf_1', confirmedFrom: 'bot@ex.com' }, [emailNotifier('nf_1')]),
    ).toEqual({ notifierId: 'nf_1', confirmedFrom: 'bot@ex.com', status: 'ok', currentFrom: 'bot@ex.com' });
  });

  it('reports notifier-missing when the id no longer resolves', () => {
    expect(
      resolveKindleSender({ notifierId: 'nf_gone', confirmedFrom: 'bot@ex.com' }, [emailNotifier('nf_1')]),
    ).toMatchObject({ status: 'notifier-missing', currentFrom: null });
  });

  it('reports not-email for a known non-email type AND an out-of-registry type', () => {
    const ntfy: RuntimeNotifier = { id: 'nf_1', name: 'Phone', type: 'ntfy', events: [], config: { url: 'https://ntfy.sh', topic: 't' } };
    const legacy: RuntimeNotifier = { id: 'nf_1', name: 'Legacy', type: 'apprise', events: [], config: {} };
    for (const nf of [ntfy, legacy]) {
      expect(resolveKindleSender({ notifierId: 'nf_1', confirmedFrom: 'bot@ex.com' }, [nf])).toMatchObject({
        status: 'not-email',
        currentFrom: null,
      });
    }
  });

  it('reports config-unusable when the runtime config fails emailRuntimeSchema', () => {
    const broken = emailNotifier('nf_1');
    broken.config = { host: 'smtp.example.com' }; // missing port/secure/from/to
    expect(resolveKindleSender({ notifierId: 'nf_1', confirmedFrom: 'bot@ex.com' }, [broken])).toMatchObject({
      status: 'config-unusable',
      currentFrom: null,
    });
  });

  it('reports from-unparseable when the live From is not a single valid mailbox', () => {
    expect(
      resolveKindleSender({ notifierId: 'nf_1', confirmedFrom: 'bot@ex.com' }, [emailNotifier('nf_1', { from: 'a@' })]),
    ).toMatchObject({ status: 'from-unparseable', currentFrom: null });
  });

  it('reports sender-changed with the live mailbox when the From moved to another address', () => {
    expect(
      resolveKindleSender({ notifierId: 'nf_1', confirmedFrom: 'bot@ex.com' }, [
        emailNotifier('nf_1', { from: 'Narratorr <new@ex.com>' }),
      ]),
    ).toEqual({ notifierId: 'nf_1', confirmedFrom: 'bot@ex.com', status: 'sender-changed', currentFrom: 'new@ex.com' });
  });

  it('compares mailboxes case-insensitively while echoing the stored casing verbatim', () => {
    const resolved = resolveKindleSender({ notifierId: 'nf_1', confirmedFrom: 'Bot@Ex.com' }, [
      emailNotifier('nf_1', { from: 'bot@ex.com' }),
    ]);
    expect(resolved).toMatchObject({ status: 'ok', confirmedFrom: 'Bot@Ex.com', currentFrom: 'bot@ex.com' });
  });

  it('NEVER falls through to another usable email notifier when the selected one is invalid', () => {
    // Two usable email notifiers; the selected id is absent. A fall-through implementation would
    // resolve `ok` against the other mailbox — the exact failure mode that breaks every
    // family member's Amazon allowlist at once.
    const resolved = resolveKindleSender({ notifierId: 'nf_gone', confirmedFrom: 'bot@ex.com' }, [
      emailNotifier('nf_a', { from: 'a@ex.com' }),
      emailNotifier('nf_b', { from: 'b@ex.com' }),
    ]);
    expect(resolved).toEqual({ notifierId: 'nf_gone', confirmedFrom: 'bot@ex.com', status: 'notifier-missing', currentFrom: null });
    expect(JSON.stringify(resolved)).not.toContain('a@ex.com');
    expect(JSON.stringify(resolved)).not.toContain('b@ex.com');
  });

  it('keeps an undecryptable SMTP password (pass: null) confirmable — deliverability is a send-time concern', () => {
    expect(
      resolveKindleSender({ notifierId: 'nf_1', confirmedFrom: 'bot@ex.com' }, [emailNotifier('nf_1', { pass: null })]),
    ).toMatchObject({ status: 'ok' });
  });
});

describe('confirmSenderMailbox — the shared write/read confirmation', () => {
  it('yields the live parsed mailbox for a confirmable notifier', () => {
    expect(confirmSenderMailbox('nf_1', [emailNotifier('nf_1', { from: 'Narratorr <Bot@Ex.com>' })])).toEqual({
      mailbox: 'Bot@Ex.com',
    });
  });

  it('yields the failure class for each unconfirmable case', () => {
    expect(confirmSenderMailbox('nf_x', [])).toEqual({ failure: 'notifier-missing' });
    expect(
      confirmSenderMailbox('nf_1', [{ id: 'nf_1', name: 'P', type: 'ntfy', events: [], config: {} }]),
    ).toEqual({ failure: 'not-email' });
  });
});
