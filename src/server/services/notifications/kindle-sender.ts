import addressparser from 'nodemailer/lib/addressparser/index.js';
import { emailRuntimeSchema } from './index.js';
import type { RuntimeNotifier } from './types.js';
import { hasDeliverableContact } from '../../../shared/schemas/user.js';
import type { KindleSenderStatus, ResolvedKindleSender, StoredConnectors } from '../../../shared/schemas/connectors.js';

/**
 * The stable Kindle sender (issue #143) — a PURE resolver over the DECRYPTED runtime notifiers
 * (the same input shape `selectEmailSource` consumes), so "usable" here means exactly what the
 * send path means. It NEVER falls through to another notifier and NEVER rewrites the selection:
 * Amazon's Approved Personal Document E-mail List is per-sender, so a silently changing From
 * would break every family member's allowlist at once. Invalidation is diagnosed, not repaired.
 *
 * Kept server-side because `nodemailer` is a Node-only dependency (AC23) — the browser never
 * parses a mailbox; the parsed value is always server-derived.
 */

/** The four confirmation failures the WRITE path can reject with (no `ok`/`sender-changed`). */
export type KindleSenderFailure = Exclude<KindleSenderStatus, 'ok' | 'sender-changed'>;

/** Confirming a notifier id → its live parsed mailbox, or the reason it can't be confirmed. */
export type SenderConfirmation = { mailbox: string } | { failure: KindleSenderFailure };

/**
 * Admin-facing explanation per rejection class. Case-SPECIFIC on purpose (AC8): all four share
 * the `KINDLE_SENDER_INVALID` code, so the message is the only thing that tells the admin which
 * notifier problem to go fix. Exported so the write path and its tests name one string each.
 */
export const KINDLE_SENDER_INVALID_MESSAGE: Record<KindleSenderFailure, string> = {
  'notifier-missing': 'That notifier no longer exists — pick an email notifier that is still configured.',
  'not-email': 'The Kindle sender must be an email (SMTP) notifier.',
  'config-unusable': 'That email notifier’s SMTP settings are incomplete or unreadable — fix the notifier, then select it again.',
  'from-unparseable': 'That email notifier’s From must be a single valid mailbox (e.g. narratorr@example.com).',
};

/**
 * The parsed mailbox of a notifier `from` string, or null when it isn't exactly one valid mailbox.
 *
 * TWO gates, both load-bearing:
 *  1. STRUCTURAL — `addressparser` returns `AddressOrGroup[]`; a group entry carries a `group`
 *     array and no `address`. Require exactly one non-group entry with a non-empty `address`.
 *     (Deliberately NOT `{ flatten: true }`: flatten silently promotes a one-member group to a
 *     valid single address, which is not the same thing as a plain mailbox.)
 *  2. VALIDITY — the parser is a SPLITTER, not a validator: when the text contains an `@` it
 *     falls back to returning that text as the address, so `'a@'`, `'@example.com'`, `'a@b'` and
 *     `'a@b@c'` all survive gate 1. `hasDeliverableContact` (the repo's single mailbox-validity
 *     predicate, shared with local login / the OIDC email gate / the availability sweep) is what
 *     makes the result a mailbox.
 *
 * The value returned is the parser's `address` VERBATIM — never lowercased or otherwise rewritten
 * (the predicate normalizes internally, but only to decide; storage and display keep the case).
 */
export function parseSingleMailbox(from: string): string | null {
  const parsed = addressparser(from);
  const only = parsed.length === 1 ? parsed[0] : undefined;
  if (!only || 'group' in only) return null;
  const address = only.address;
  if (typeof address !== 'string' || address === '') return null;
  return hasDeliverableContact(address) ? address : null;
}

/**
 * Resolve a notifier id against the live runtime notifiers → its confirmable mailbox, or the
 * failure that blocks confirmation. Shared by the WRITE path (which rejects a failure with a
 * case-specific 400) and the READ path below, so a selection can never be stored in a state the
 * resolver would immediately call invalid.
 */
export function confirmSenderMailbox(notifierId: string, notifiers: RuntimeNotifier[]): SenderConfirmation {
  const nf = notifiers.find((n) => n.id === notifierId);
  if (!nf) return { failure: 'notifier-missing' };
  if (nf.type !== 'email') return { failure: 'not-email' };
  const config = emailRuntimeSchema.safeParse(nf.config);
  // An undecryptable password reveals as `null`, which the schema's nullable `pass` accepts —
  // deliverability is a send-time concern, and this matches `selectEmailSource`'s predicate.
  if (!config.success) return { failure: 'config-unusable' };
  const mailbox = parseSingleMailbox(config.data.from);
  if (mailbox === null) return { failure: 'from-unparseable' };
  return { mailbox };
}

/**
 * The read-time verdict on a stored selection. `null` selection → `null` (nothing chosen).
 * Otherwise the stored pair is echoed VERBATIM alongside the status and the live mailbox:
 *   • any confirmation failure → that status, `currentFrom: null`;
 *   • confirmable but different from `confirmedFrom` → `sender-changed` (+ the live mailbox);
 *   • confirmable and equal → `ok`.
 *
 * Mailbox equality is CASE-INSENSITIVE (Amazon's allowlist isn't case-sensitive, and an admin
 * retyping `Bot@Ex.com` as `bot@ex.com` must not read as a sender change) while the returned
 * `confirmedFrom` stays exactly what was stored.
 */
export function resolveKindleSender(
  selection: StoredConnectors['kindleSender'],
  notifiers: RuntimeNotifier[],
): ResolvedKindleSender | null {
  if (!selection) return null;
  const { notifierId, confirmedFrom } = selection;
  const confirmation = confirmSenderMailbox(notifierId, notifiers);
  if ('failure' in confirmation) {
    return { notifierId, confirmedFrom, status: confirmation.failure, currentFrom: null };
  }
  const same = confirmation.mailbox.toLowerCase() === confirmedFrom.toLowerCase();
  return {
    notifierId,
    confirmedFrom,
    status: same ? 'ok' : 'sender-changed',
    currentFrom: confirmation.mailbox,
  };
}
