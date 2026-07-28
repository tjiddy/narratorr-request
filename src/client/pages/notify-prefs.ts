import { NOTIFIABLE_TRANSITIONS, type NotifiableTransition, type UpdateMeBody } from '@shared/schemas/user';

// Pure logic for the account modal (issue #131): the requester-notification opt-in checkboxes, the
// contact-email save row, the Send-to-Kindle address save row (#142), and the identity provider
// line. Extracted from the React component so it's unit-testable without a jsdom harness
// (frontend-logic-extract-not-jsdom): the component wires these to inputs, these decide state. The
// PATCH /api/me body is `{ notifyOn?, email?, kindleEmail? }` — all three independent and optional.
//
// The three email-field helpers below (`isEmailFieldDirty` / `emailFieldPatchValue` /
// `reconciledEmailFieldDraft`) are FIELD-GENERIC on purpose: the contact row and the Kindle row
// share them rather than each owning a copy. Cloning them per row is how the case-normalization
// false-dirty bug `reconciledEmailFieldDraft` exists to fix creeps back in on the second row.

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
 * Whether an email-field Save button is active (dirty): true when the trimmed draft differs from the
 * stored value (null reads as the empty string). Each Save is spatially scoped to its own row — it
 * commits ONLY that field — so this drives its at-rest-vs-amber state independent of the other row
 * and of the notify toggles. Shared by the contact-email row and the Kindle-address row (#142).
 */
export function isEmailFieldDirty(stored: string | null, draft: string): boolean {
  return draft.trim() !== (stored ?? '');
}

/**
 * The PATCH-body value for an email field from its draft: an empty (or whitespace-only) field clears
 * it (`null`), any other value is sent trimmed for the server's schema to normalize + validate (an
 * invalid address 400s and surfaces inline). Clearing is always `null`; the empty string is never
 * sent (it would 400 — the server rejects `""` as a non-clear, for both `email` and `kindleEmail`).
 */
export function emailFieldPatchValue(draft: string): string | null {
  const trimmed = draft.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * The draft to adopt after a SUCCESSFUL save, reconciled to the server's returned value (already
 * normalized: trimmed + lowercased, or `null` when cleared). Without this, a save of e.g.
 * `New@Contact.COM` normalizes server-side to `new@contact.com` while the input keeps the
 * pre-normalized draft, so {@link isEmailFieldDirty} — a case-sensitive compare — would leave Save
 * falsely amber. Resetting the draft to the returned value makes the row clean again. Composing this
 * with `isEmailFieldDirty(saved, reconciledEmailFieldDraft(saved))` is always `false` — the tested
 * invariant. Applies to BOTH rows: `MeDto.email` and `MeDto.kindleEmail` (#142).
 */
export function reconciledEmailFieldDraft(saved: string | null): string {
  return saved ?? '';
}

/** Where to find the device address, for the Kindle row's helper copy (#142). */
export const KINDLE_EMAIL_HELP = 'Find it in Amazon: Devices > your Kindle > Email.';

/**
 * The success toast for a `useUpdateMe` mutation, or `null` for none — feedback proportional to the
 * action (#134). The account modal routes three shapes through the hook: an explicit contact-email
 * Save, an explicit Kindle-address Save (#142), and instant-apply notification checkboxes.
 *   • Any body carrying `email` (set OR `null`-clear) → "Email saved".
 *   • Any body carrying `kindleEmail` → "Kindle address saved". BOTH explicit Saves must toast: the
 *     field looks identical before and after, so without an ack the button applies silently.
 *   • A `notifyOn`-only (or empty) body → `null` (silent). The persisted checkbox is the confirmation
 *     (the platform convention for instant-apply toggles), which also avoids toast-stacking when
 *     several boxes are toggled.
 * Precedence is DETERMINISTIC and `email`-first. The modal's Saves are row-scoped, so a body carrying
 * both never arises from the UI; a caller that hand-builds one gets one toast, not two.
 * Keyed on the presence of the KEY, not its value, so a `null` clear on either field still toasts.
 * Errors are handled separately in the hook and always toast, regardless of shape.
 */
export function meSuccessToast(body: UpdateMeBody): string | null {
  if ('email' in body) return 'Email saved';
  if ('kindleEmail' in body) return 'Kindle address saved';
  return null;
}
