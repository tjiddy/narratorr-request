import { NOTIFIABLE_TRANSITIONS, type NotifiableTransition } from '@shared/schemas/user';

// Pure logic for the requester-notification opt-in control + discoverability nudge (issue #50).
// Extracted from the React component so it's unit-testable without a jsdom harness
// (frontend-logic-extract-not-jsdom): the component wires these to inputs/localStorage, these
// decide state. The PATCH /api/me body is `{ notifyOn: NotifiableTransition[] }`.

/** Human label per transition, for the opt-in checkboxes. Keyed to `NOTIFIABLE_TRANSITIONS`. */
export const NOTIFY_TRANSITION_LABELS: Record<NotifiableTransition, string> = {
  available: 'When my request is ready to listen',
};

/**
 * Toggle one transition in the opt-in set, returning a NEW array (never mutates). Enabling adds
 * it (de-duped); disabling removes it. The result is filtered to the current
 * `NOTIFIABLE_TRANSITIONS` so a stale/legacy value can never ride back into the PATCH body, and
 * ordered by the const so the payload is stable regardless of click order.
 */
export function toggleNotifyOn(
  current: readonly NotifiableTransition[],
  transition: NotifiableTransition,
  enabled: boolean,
): NotifiableTransition[] {
  const set = new Set(current);
  if (enabled) set.add(transition);
  else set.delete(transition);
  return NOTIFIABLE_TRANSITIONS.filter((t) => set.has(t));
}

/**
 * Whether the opt-in control is disabled: true when the caller has no usable email delivery
 * (no contact, or no usable email-notifier SMTP source). The control renders disabled with an
 * explanation rather than 403-ing — opt-in storage is permissive, but toggling is pointless
 * until delivery is possible, so the UI gates it on `emailNotifyAvailable`.
 */
export function optInDisabled(emailNotifyAvailable: boolean): boolean {
  return !emailNotifyAvailable;
}

/**
 * Whether to show the one-time discoverability nudge pointing at the opt-in control. Shown only
 * when email delivery is available AND the user hasn't opted into anything yet AND they haven't
 * dismissed the nudge before. Off-by-default + email-only risks the flagship feature being
 * invisible; this surfaces it exactly once to users who could actually use it.
 */
export function shouldShowNudge(
  emailNotifyAvailable: boolean,
  notifyOn: readonly NotifiableTransition[],
  dismissed: boolean,
): boolean {
  return emailNotifyAvailable && notifyOn.length === 0 && !dismissed;
}
