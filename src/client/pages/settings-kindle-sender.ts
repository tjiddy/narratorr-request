import { isKnownNotifierDto } from '@shared/schemas/connectors';
import type {
  NotifierDto,
  ResolvedKindleSender,
  UpdateConnectorSettingsBody,
} from '@shared/schemas/connectors';

// Pure decision logic for the Kindle-sender picker (issue #143) — eligibility, draft
// seeding/rebasing, persist intent, payload build, and the per-status diagnosis copy. Kept out
// of the component per CLAUDE.md: the `.test.tsx` covers status-dependent RENDERING and the
// query-refetch wiring; every decision below is unit-tested here.
//
// The card separates three things and never conflates them:
//   • SAVED    — `dto.kindleSender`, the server's resolved view of the stored pair.
//   • DRAFT    — `selectedId`, always an ELIGIBLE id or null (the AC20 invariant).
//   • INTENT   — derived from both; Save renders exactly when it isn't `noop`.

/** A selectable sender: a known email notifier DTO row carrying a raw `from` string. */
export interface KindleSenderOption {
  id: string;
  name: string;
  /** The notifier's RAW `from` (pre-save display only) — the parsed mailbox is server-derived. */
  from: string;
}

/**
 * The eligible picker options. Eligibility is STRUCTURAL: a row must be KNOWN (not degraded),
 * `type === 'email'`, and carry a string `config.from`.
 *
 * Raw type alone is NOT enough — `toNotifierDto()` degrades a known email row whose config fails
 * masking into `{ type: 'email', unknown: true }` with no `config`, and the server could never
 * confirm such a row (its runtime config fails `emailRuntimeSchema` too). Offering or
 * auto-preselecting it would put a guaranteed-400 Save in front of the admin. The known/degraded
 * call is made by the SHARED `isKnownNotifierDto` guard, the same one the notifier list uses for
 * its Edit/Test affordances, so the two surfaces can't disagree about a given row.
 *
 * The client deliberately does NOT judge whether `from` is a valid MAILBOX — that is
 * server-derived (nodemailer is Node-only). An eligible-but-unparseable row is rejected on Save
 * with a case-specific 400.
 */
export function eligibleKindleSenders(notifiers: NotifierDto[]): KindleSenderOption[] {
  return notifiers.flatMap((n) => {
    if (!isKnownNotifierDto(n) || n.type !== 'email') return [];
    const from = n.config.from;
    return typeof from === 'string' ? [{ id: n.id, name: n.name, from }] : [];
  });
}

/**
 * The draft the picker starts from:
 *   • a saved id that is in the eligible set → that id (whatever its status — a `sender-changed`
 *     or `from-unparseable` selection is still the row the admin is reconfirming/looking at);
 *   • a saved id that is NOT eligible → null, so a broken selection never enters the picker and
 *     therefore never becomes a same-id Save the server guarantees to reject;
 *   • no saved value → the SOLE eligible option when there is exactly one, else null.
 * Seeding never persists anything.
 */
export function seedKindleDraft(
  saved: ResolvedKindleSender | null,
  options: KindleSenderOption[],
): string | null {
  if (saved) return options.some((o) => o.id === saved.notifierId) ? saved.notifierId : null;
  return options.length === 1 ? options[0]!.id : null;
}

/**
 * Re-derive the draft after the connector query refetches (notifier CRUD invalidates it while the
 * Notifications section stays mounted, so the card outlives changes to its own option set).
 * A manual draft SURVIVES only while it is still eligible; otherwise it falls back to the seeding
 * rule. Either way the AC20 invariant holds: the result is always an eligible id or null.
 */
export function rebaseKindleDraft(
  draft: string | null,
  saved: ResolvedKindleSender | null,
  options: KindleSenderOption[],
): string | null {
  if (draft !== null && options.some((o) => o.id === draft)) return draft;
  return seedKindleDraft(saved, options);
}

/** What pressing Save would do. `noop` never issues a request (and hides Save). */
export type KindleSenderIntent = 'set' | 'clear' | 'noop';

/**
 * The persist intent, total over (saved, draft):
 *   • `set`   — a draft is selected AND (nothing saved, OR a different id, OR the saved selection
 *               is `sender-changed`, which is the ONE status a same-id write can confirm).
 *   • `clear` — no draft while something is saved.
 *   • `noop`  — everything else, notably a same-id draft on any other status: AC8 guarantees the
 *               server would 400 that write, so the card must not offer it.
 */
export function kindleSenderIntent(
  saved: ResolvedKindleSender | null,
  selectedId: string | null,
): KindleSenderIntent {
  if (selectedId === null) return saved ? 'clear' : 'noop';
  if (!saved) return 'set';
  if (selectedId !== saved.notifierId) return 'set';
  return saved.status === 'sender-changed' ? 'set' : 'noop';
}

/**
 * The PUT body for the current intent, or null when there is nothing to submit. The `kindleSender`
 * key is PRESENT for `set`/`clear` and the body is never built at all for `noop` — it is never
 * sent as `undefined` (`exactOptionalPropertyTypes` + the `.strict()` write body).
 */
export function buildKindleSenderBody(
  saved: ResolvedKindleSender | null,
  selectedId: string | null,
): UpdateConnectorSettingsBody | null {
  switch (kindleSenderIntent(saved, selectedId)) {
    case 'set':
      return { kindleSender: { notifierId: selectedId! } };
    case 'clear':
      return { kindleSender: null };
    case 'noop':
      return null;
  }
}

/**
 * What is wrong with the saved sender, per status. DIAGNOSIS only — it names the faulty notifier
 * and why it can't be confirmed, and deliberately does NOT script a repair procedure in the
 * notifier list: those affordances live in another component and differ per row kind (a known row
 * has Edit + Delete; a degraded row has Delete only). The identity rule below covers when a Save
 * here is required, for every repair shape, which a procedure could not.
 */
export function kindleSenderDiagnosis(saved: ResolvedKindleSender): string | null {
  switch (saved.status) {
    case 'ok':
      return null;
    case 'sender-changed':
      return `This notifier now sends as ${saved.currentFrom ?? 'a different address'} (confirmed: ${saved.confirmedFrom}). Reconfirm to update the address to allowlist.`;
    case 'from-unparseable':
      return 'This notifier’s From is not a single valid mailbox, so it cannot be confirmed.';
    case 'config-unusable':
      return 'This notifier’s stored SMTP config is unreadable, so it cannot be confirmed.';
    case 'not-email':
      return 'The saved sender is no longer an email notifier.';
    case 'notifier-missing':
      return `The notifier that sent as ${saved.confirmedFrom} no longer exists.`;
  }
}

/**
 * The single rule that covers every recovery shape — stated instead of per-status procedures.
 * Editing a notifier in place keeps its id, so the stored pair re-resolves with no write here;
 * anything that changes WHICH notifier sends (delete + recreate mints a fresh id, or picking a
 * different one) needs a Save here, because the selector is never auto-reselected.
 */
export const KINDLE_IDENTITY_RULE =
  'Kindle delivery resumes only when a sender is selected here and saved. Editing a notifier in place keeps its identity, so a same-notifier fix needs no save here; anything that changes which notifier sends — recreating it, or choosing a different one — needs a save here.';
