import { describe, it, expect } from 'vitest';
import {
  UNIT_DAYS,
  daysLabel,
  buildDefaultQuota,
  initDefaultQuota,
  isDefaultQuotaValid,
  isDefaultQuotaDirty,
  type DefaultQuotaState,
} from './settings-default-quota';

const state = (over: Partial<DefaultQuotaState> = {}): DefaultQuotaState => ({ mode: 'limited', limit: '3', unit: 'week', ...over });

describe('unit ↔ days mapping', () => {
  it('maps each unit to its fixed day count (day=1, week=7, month=30)', () => {
    expect(UNIT_DAYS).toEqual({ day: 1, week: 7, month: 30 });
  });

  it('seeds the form from a limited DTO, mapping days back to a unit', () => {
    expect(initDefaultQuota({ mode: 'limited', limit: 3, windowDays: 7 })).toEqual({ mode: 'limited', limit: '3', unit: 'week' });
    expect(initDefaultQuota({ mode: 'limited', limit: 5, windowDays: 1 })).toEqual({ mode: 'limited', limit: '5', unit: 'day' });
    expect(initDefaultQuota({ mode: 'limited', limit: 10, windowDays: 30 })).toEqual({ mode: 'limited', limit: '10', unit: 'month' });
  });

  it('seeds an unlimited DTO as no-cap mode + a blank limit (window retained)', () => {
    expect(initDefaultQuota({ mode: 'unlimited', windowDays: 30 })).toEqual({ mode: 'unlimited', limit: '', unit: 'month' });
  });
});

describe('isDefaultQuotaValid', () => {
  it('unlimited mode is always valid (limit field irrelevant)', () => {
    expect(isDefaultQuotaValid(state({ mode: 'unlimited', limit: '' }))).toBe(true);
    expect(isDefaultQuotaValid(state({ mode: 'unlimited', limit: 'junk' }))).toBe(true);
  });

  it('limited mode requires a valid positive cap (rejects blank/0/decimal/sci/hex/negative)', () => {
    expect(isDefaultQuotaValid(state({ mode: 'limited', limit: '3' }))).toBe(true);
    for (const bad of ['', '0', '3.5', '-1', 'abc', '1e3', '0x10', '5x', '-0']) {
      expect(isDefaultQuotaValid(state({ mode: 'limited', limit: bad }))).toBe(false);
    }
  });

  it('limited rejects a digit string past the safe-integer range (no silent → unlimited)', () => {
    const huge = '9'.repeat(20);
    expect(isDefaultQuotaValid(state({ mode: 'limited', limit: huge }))).toBe(false);
  });
});

describe('buildDefaultQuota', () => {
  it('builds a limited payload from the form', () => {
    expect(buildDefaultQuota(state({ mode: 'limited', limit: '3', unit: 'week' }))).toEqual({ mode: 'limited', limit: 3, windowDays: 7 });
  });

  it('builds an unlimited payload, still sending the window', () => {
    expect(buildDefaultQuota(state({ mode: 'unlimited', limit: '', unit: 'month' }))).toEqual({ mode: 'unlimited', windowDays: 30 });
  });

  it('a limited mode with an invalid limit degrades to unlimited rather than throwing', () => {
    expect(buildDefaultQuota(state({ mode: 'limited', limit: '', unit: 'day' }))).toEqual({ mode: 'unlimited', windowDays: 1 });
  });
});

describe('daysLabel', () => {
  it('renders the `= N days` hint for the unit', () => {
    expect(daysLabel('day')).toBe('= 1 days');
    expect(daysLabel('week')).toBe('= 7 days');
    expect(daysLabel('month')).toBe('= 30 days');
  });
});

describe('isDefaultQuotaDirty', () => {
  const saved = initDefaultQuota({ mode: 'limited', limit: 3, windowDays: 7 }); // { mode:'limited', limit:'3', unit:'week' }

  it('is clean when nothing changed', () => {
    expect(isDefaultQuotaDirty(saved, saved)).toBe(false);
  });

  it('is dirty when the mode changes', () => {
    expect(isDefaultQuotaDirty(state({ mode: 'unlimited', limit: '3', unit: 'week' }), saved)).toBe(true);
  });

  it('is dirty when the limit changes (within limited)', () => {
    expect(isDefaultQuotaDirty(state({ mode: 'limited', limit: '5', unit: 'week' }), saved)).toBe(true);
  });

  it('is dirty when the unit changes (within limited)', () => {
    expect(isDefaultQuotaDirty(state({ mode: 'limited', limit: '3', unit: 'month' }), saved)).toBe(true);
  });

  it('within unlimited, the typed limit is irrelevant — clean against another unlimited (same window)', () => {
    const unlimited = initDefaultQuota({ mode: 'unlimited', windowDays: 30 }); // { mode:'unlimited', limit:'', unit:'month' }
    expect(isDefaultQuotaDirty({ mode: 'unlimited', limit: '99', unit: 'month' }, unlimited)).toBe(false);
  });

  it('within unlimited, a window change is still dirty (the window persists on both modes)', () => {
    const unlimited = initDefaultQuota({ mode: 'unlimited', windowDays: 30 });
    expect(isDefaultQuotaDirty({ mode: 'unlimited', limit: '', unit: 'day' }, unlimited)).toBe(true);
  });

  it('is dirty when an invalid limit is typed in limited mode (so the Save affordance shows)', () => {
    expect(isDefaultQuotaDirty(state({ mode: 'limited', limit: '3.5', unit: 'week' }), saved)).toBe(true);
  });
});
