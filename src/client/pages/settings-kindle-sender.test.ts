import { describe, it, expect } from 'vitest';
import type { NotifierDto, ResolvedKindleSender, KindleSenderStatus } from '@shared/schemas/connectors';
import {
  eligibleKindleSenders,
  seedKindleDraft,
  rebaseKindleDraft,
  kindleSenderIntent,
  buildKindleSenderBody,
  type KindleSenderOption,
} from './settings-kindle-sender';

const emailConfig = { host: 'smtp.example.com', port: 587, secure: false, user: null, to: 'a@ex.com', hasPassword: true };
const emailRow = (id: string, config: Record<string, unknown> = { ...emailConfig, from: 'bot@ex.com' }): NotifierDto => ({
  id,
  name: `Mail ${id}`,
  type: 'email',
  events: ['request.created'],
  config,
});
// What `toNotifierDto()` emits for a known email row whose config fails masking: raw type
// 'email', but degraded — no `config`, so no `from` the server could ever confirm.
const degradedEmailRow = (id: string): NotifierDto => ({
  id,
  name: `Broken ${id}`,
  type: 'email',
  events: ['request.created'],
  unknown: true,
});
const ntfyRow = (id: string): NotifierDto => ({
  id,
  name: `Phone ${id}`,
  type: 'ntfy',
  events: ['request.created'],
  config: { url: 'https://ntfy.sh', topic: 't', hasToken: false, priority: null },
});

const opts = (...ids: string[]): KindleSenderOption[] => ids.map((id) => ({ id, name: id, from: 'bot@ex.com' }));
const savedAs = (notifierId: string, status: KindleSenderStatus = 'ok'): ResolvedKindleSender => ({
  notifierId,
  confirmedFrom: 'bot@ex.com',
  status,
  currentFrom: status === 'ok' ? 'bot@ex.com' : status === 'sender-changed' ? 'new@ex.com' : null,
});

describe('eligibleKindleSenders', () => {
  it('offers a known email row carrying a string config.from', () => {
    expect(eligibleKindleSenders([emailRow('nf_1')])).toEqual([{ id: 'nf_1', name: 'Mail nf_1', from: 'bot@ex.com' }]);
  });

  it('excludes an ntfy row', () => {
    expect(eligibleKindleSenders([ntfyRow('nf_1')])).toEqual([]);
  });

  it('excludes a DEGRADED email row — neither offered nor counted', () => {
    // A sole degraded email row ⇒ ZERO eligible, so nothing is preselected either.
    const options = eligibleKindleSenders([degradedEmailRow('nf_bad')]);
    expect(options).toEqual([]);
    expect(seedKindleDraft(null, options)).toBeNull();
  });

  it('a degraded row beside one healthy email row leaves exactly ONE eligible (which preselects)', () => {
    const options = eligibleKindleSenders([degradedEmailRow('nf_bad'), emailRow('nf_ok')]);
    expect(options.map((o) => o.id)).toEqual(['nf_ok']);
    expect(seedKindleDraft(null, options)).toBe('nf_ok');
  });

  it('excludes a known email row whose config.from is missing or non-string', () => {
    expect(eligibleKindleSenders([emailRow('nf_1', { ...emailConfig })])).toEqual([]);
    expect(eligibleKindleSenders([emailRow('nf_1', { ...emailConfig, from: 42 })])).toEqual([]);
  });
});

describe('seedKindleDraft', () => {
  it('with no saved value: preselects a SOLE eligible option, else null', () => {
    expect(seedKindleDraft(null, opts('nf_1'))).toBe('nf_1');
    expect(seedKindleDraft(null, opts())).toBeNull();
    expect(seedKindleDraft(null, opts('nf_1', 'nf_2'))).toBeNull();
  });

  it('seeds a saved id that is in the eligible set — whatever its status', () => {
    for (const status of ['ok', 'sender-changed', 'from-unparseable'] as const) {
      expect(seedKindleDraft(savedAs('nf_1', status), opts('nf_1', 'nf_2')), status).toBe('nf_1');
    }
  });

  it('seeds NULL for a saved id absent from the eligible set (deleted, retyped, or degraded)', () => {
    // Even with a sole other eligible option, the saved-but-ineligible case seeds null — never
    // an auto-reselect (AC13), and never a draft the picker can't represent (AC20).
    expect(seedKindleDraft(savedAs('nf_gone', 'notifier-missing'), opts('nf_other'))).toBeNull();
    expect(seedKindleDraft(savedAs('nf_1', 'not-email'), opts())).toBeNull();
    expect(seedKindleDraft(savedAs('nf_1', 'config-unusable'), opts('nf_2', 'nf_3'))).toBeNull();
  });
});

describe('rebaseKindleDraft — the AC20 invariant after a connectors refetch', () => {
  it('keeps a manual draft while it is still eligible', () => {
    expect(rebaseKindleDraft('nf_2', null, opts('nf_1', 'nf_2'))).toBe('nf_2');
    expect(rebaseKindleDraft('nf_2', savedAs('nf_1'), opts('nf_1', 'nf_2'))).toBe('nf_2');
  });

  it('falls back to the seeding rule when the manual draft is no longer eligible', () => {
    // Deleted while the section stayed mounted: no saved value + one remaining option → preselect.
    expect(rebaseKindleDraft('nf_2', null, opts('nf_1'))).toBe('nf_1');
    // …and with a saved eligible id, the saved id is what it falls back to.
    expect(rebaseKindleDraft('nf_2', savedAs('nf_1'), opts('nf_1'))).toBe('nf_1');
    // Nothing eligible at all → null.
    expect(rebaseKindleDraft('nf_2', savedAs('nf_2', 'notifier-missing'), opts())).toBeNull();
  });

  it('applies the sole-option preselect across zero↔one↔many transitions ONLY when nothing is saved', () => {
    expect(rebaseKindleDraft(null, null, opts())).toBeNull();
    expect(rebaseKindleDraft(null, null, opts('nf_1'))).toBe('nf_1');
    expect(rebaseKindleDraft(null, null, opts('nf_1', 'nf_2'))).toBeNull();
    // With a saved (but ineligible) selection, a newly-added sole option is NOT adopted.
    expect(rebaseKindleDraft(null, savedAs('nf_gone', 'notifier-missing'), opts('nf_new'))).toBeNull();
  });

  it('always yields an eligible id or null (the invariant itself)', () => {
    const options = opts('nf_1', 'nf_2');
    for (const draft of [null, 'nf_1', 'nf_2', 'nf_stale']) {
      for (const saved of [null, savedAs('nf_1'), savedAs('nf_gone', 'notifier-missing')]) {
        const next = rebaseKindleDraft(draft, saved, options);
        expect(next === null || options.some((o) => o.id === next)).toBe(true);
      }
    }
  });
});

describe('kindleSenderIntent — one assertion per row of the contract table', () => {
  it('null saved + null draft → noop (Save hidden)', () => {
    expect(kindleSenderIntent(null, null)).toBe('noop');
  });

  it('null saved + a draft → set (the auto-preselected case is reachable)', () => {
    expect(kindleSenderIntent(null, 'nf_1')).toBe('set');
  });

  it('a saved selection + null draft → clear', () => {
    expect(kindleSenderIntent(savedAs('nf_1'), null)).toBe('clear');
  });

  it('a saved selection + a DIFFERENT draft → set', () => {
    expect(kindleSenderIntent(savedAs('nf_1'), 'nf_2')).toBe('set');
  });

  it('same id on sender-changed → set (the reconfirm)', () => {
    expect(kindleSenderIntent(savedAs('nf_1', 'sender-changed'), 'nf_1')).toBe('set');
  });

  it('same id on ok → noop', () => {
    expect(kindleSenderIntent(savedAs('nf_1', 'ok'), 'nf_1')).toBe('noop');
  });

  // Every remaining non-ok status: AC8 guarantees the server 400s a same-id write, so the intent
  // must be noop or the card would render a Save that can only fail.
  it.each(['from-unparseable', 'config-unusable', 'not-email', 'notifier-missing'] as const)(
    'same id on %s → noop (a same-id Save would be a guaranteed 400)',
    (status) => {
      expect(kindleSenderIntent(savedAs('nf_1', status), 'nf_1')).toBe('noop');
    },
  );
});

describe('buildKindleSenderBody', () => {
  it('set → { kindleSender: { notifierId } } (id only — the server derives the confirmation)', () => {
    expect(buildKindleSenderBody(null, 'nf_1')).toEqual({ kindleSender: { notifierId: 'nf_1' } });
    expect(buildKindleSenderBody(savedAs('nf_1', 'sender-changed'), 'nf_1')).toEqual({ kindleSender: { notifierId: 'nf_1' } });
  });

  it('clear → { kindleSender: null }', () => {
    expect(buildKindleSenderBody(savedAs('nf_1'), null)).toEqual({ kindleSender: null });
  });

  it('noop → no body at all (the key is never sent as undefined)', () => {
    expect(buildKindleSenderBody(null, null)).toBeNull();
    expect(buildKindleSenderBody(savedAs('nf_1', 'ok'), 'nf_1')).toBeNull();
  });
});
