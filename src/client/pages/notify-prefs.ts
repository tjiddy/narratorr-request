import { NOTIFIABLE_TRANSITIONS, type NotifiableTransition } from '@shared/schemas/user';

// Pure logic for the account modal (issue #131): the requester-notification opt-in checkboxes, the
// contact-email save row, and the identity provider line. Extracted from the React component so
// it's unit-testable without a jsdom harness (frontend-logic-extract-not-jsdom): the component
// wires these to inputs, these decide state. The PATCH /api/me body is
// `{ notifyOn?: NotifiableTransition[]; email?: string | null }` (both fields independent/optional).

/**
 * Short label per transition, for the notifications row. Keyed to `NOTIFIABLE_TRANSITIONS`. These
 * are the trailing half of the lead line "Email me when my request is …" — so they read as
 * "approved" / "denied" / "ready to listen".
 */
export const NOTIFY_TRANSITION_LABELS: Record<NotifiableTransition, string> = {
  approved: 'approved',
  denied: 'denied',
  available: 'ready to listen',
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
 * The identity provider line's label for the account modal. Maps the `MeDto.authProvider` id (only
 * an id — no display label) to human copy, reusing the `useAuthProviders` list to resolve a
 * configured OIDC provider's label: `local` → "email", `plex` → "Plex", any configured OIDC id →
 * its label, and a raw-id fallback when no configured label matches (unknown id, or the providers
 * list is still loading / absent). The component renders "Signed in with {label}".
 */
export function providerLabel(
  authProvider: string,
  providers: readonly { id: string; label: string }[],
): string {
  if (authProvider === 'local') return 'email';
  if (authProvider === 'plex') return 'Plex';
  return providers.find((p) => p.id === authProvider)?.label ?? authProvider;
}

/**
 * Whether the email Save button is active (dirty): true when the trimmed draft differs from the
 * stored contact (null reads as the empty string). Save is spatially scoped to the email row — it
 * commits ONLY email — so this drives its at-rest-vs-amber state independent of the notify toggles.
 */
export function isEmailDirty(stored: string | null, draft: string): boolean {
  return draft.trim() !== (stored ?? '');
}

/**
 * The `email` value for the PATCH body from the draft field: an empty (or whitespace-only) field
 * clears the contact (`null`), any other value is sent trimmed for the server's `contactEmailSchema`
 * to normalize + validate (an invalid address 400s and surfaces inline). Clearing is `email: null`;
 * the empty string is never sent (it would 400 — the server rejects `""` as a non-clear).
 */
export function emailPatchValue(draft: string): string | null {
  const trimmed = draft.trim();
  return trimmed === '' ? null : trimmed;
}
