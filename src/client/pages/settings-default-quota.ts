import type { ConnectorSettingsDto, UpdateConnectorSettingsBody, QuotaWindowDays } from '@shared/schemas/connectors';
import { parsePositiveLimit, isPositiveLimitValid } from './quota-limit';

// Default-request-quota card form state + decision logic. Pulled out of SettingsConnection as
// pure functions so the mode toggle, unit↔days mapping, payload build/validate, the `= N days`
// hint and the dirty check are unit-tested without a DOM (vitest node env), matching the other
// client logic helpers (e.g. settings-narratorr.ts). Mode-first: the admin picks `No default cap`
// or `Limit requests`, and (for limited) a friendly day/week/month unit mapped to a FIXED
// rolling-window day count (no calendar period).

export type QuotaUnit = 'day' | 'week' | 'month';

/** The default quota is one of two modes — `unlimited` (no cap) or `limited` (a positive cap). */
export type DefaultQuotaMode = 'unlimited' | 'limited';

/** Fixed friendly-unit → rolling-window-days map. The single source of truth both directions. */
export const UNIT_DAYS: Record<QuotaUnit, QuotaWindowDays> = { day: 1, week: 7, month: 30 };

/** Ordered units for the dropdown. */
export const QUOTA_UNITS: QuotaUnit[] = ['day', 'week', 'month'];

const DAYS_UNIT: Record<number, QuotaUnit> = { 1: 'day', 7: 'week', 30: 'month' };

export type DefaultQuotaState = {
  mode: DefaultQuotaMode;
  /** The limit as typed (string-backed number input). Only meaningful when mode = 'limited'. */
  limit: string;
  unit: QuotaUnit;
};

/** Seed the form from the saved DTO. `unlimited` → no-cap mode, blank limit; `limited` → the cap.
 *  `windowDays` (on both modes) maps back to its unit. */
export const initDefaultQuota = (q: ConnectorSettingsDto['defaultQuota']): DefaultQuotaState => ({
  mode: q.mode,
  limit: q.mode === 'limited' ? String(q.limit) : '',
  unit: DAYS_UNIT[q.windowDays] ?? 'month',
});

/** The `= N days` hint rendered next to the unit dropdown (e.g. month → `= 30 days`). */
export const daysLabel = (unit: QuotaUnit): string => `= ${UNIT_DAYS[unit]} days`;

/**
 * Whether the form is acceptable to save: `unlimited` is always valid; `limited` requires a valid
 * positive-int cap (blank/0/decimal/sci/hex/over-ceiling all rejected — see {@link parsePositiveLimit}).
 */
export const isDefaultQuotaValid = (s: DefaultQuotaState): boolean =>
  s.mode === 'unlimited' || isPositiveLimitValid(s.limit);

/**
 * Build the PUT payload from the form. Assumes a valid form (the component only submits when
 * {@link isDefaultQuotaValid}); a limited mode with an unexpectedly-invalid limit degrades to
 * unlimited rather than throwing. Always sends `windowDays` (the unit dropdown is the source of truth).
 */
export const buildDefaultQuota = (s: DefaultQuotaState): NonNullable<UpdateConnectorSettingsBody['defaultQuota']> => {
  const windowDays = UNIT_DAYS[s.unit];
  if (s.mode === 'limited') {
    const parsed = parsePositiveLimit(s.limit);
    if (parsed.ok) return { mode: 'limited', limit: parsed.value, windowDays };
  }
  return { mode: 'unlimited', windowDays };
};

/**
 * Dirty when the mode, the effective limit, or the unit differs from the saved baseline. In
 * `limited` mode an invalid current limit counts as dirty (so the user sees the Save affordance to
 * correct it) via a raw-string compare; the baseline is always valid.
 */
export const isDefaultQuotaDirty = (s: DefaultQuotaState, initial: DefaultQuotaState): boolean => {
  if (s.mode !== initial.mode) return true;
  if (s.mode === 'unlimited') return s.unit !== initial.unit; // limit irrelevant when uncapped
  if (s.unit !== initial.unit) return true;
  const cur = parsePositiveLimit(s.limit);
  const base = parsePositiveLimit(initial.limit);
  if (!cur.ok || !base.ok) return s.limit.trim() !== initial.limit.trim();
  return cur.value !== base.value;
};
