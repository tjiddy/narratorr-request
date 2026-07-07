import nodemailer, { type Transporter } from 'nodemailer';
import { emailRuntimeSchema, type EmailRuntimeConfig } from './index.js';
import type { NotificationsConfig } from './types.js';
import type { NotifiableTransition } from '../../../shared/schemas/user.js';

/**
 * Requester-facing email (issue #50) — the SIGNATURE Overseerr behavior: the person who made
 * a request is emailed when it reaches a transition they opted into (v1: `available` only).
 *
 * Deliberately SEPARATE from the admin notifier path (`render()` / `EmailChannel` / `Notifier`):
 *   • content links the REQUESTER to their own My Requests page, never an admin surface;
 *   • it never emits an admin `NotificationEvent` and never sends to the admin `cfg.to`.
 * It reuses only the operator's already-configured email notifier's SMTP TRANSPORT CONFIG
 * (host/port/secure/auth/from) — sharing credentials, not recipient routing (AC8).
 */

// --- SMTP source selection ---------------------------------------------------

/**
 * The requester-email SMTP source: the FIRST *usable* `type: 'email'` notifier in stored order
 * (the runtime config from `getNotificationsConfig()`, already decrypted). "Usable" = its runtime
 * config passes `emailRuntimeSchema` — the SAME predicate `buildNotifierChannel('email', …)` /
 * `buildOne` use to decide a notifier is deliverable (`user`/`pass` nullable, so a passwordless /
 * open-relay source is usable). A malformed / undecryptable email row fails the parse and is
 * SKIPPED, and the next `type: 'email'` row is considered — mirroring `buildNotifier`'s
 * degrade-and-continue. Stored order is admin-controlled and stable, so selection is deterministic
 * for 0, 1, or 2+ email notifiers. Returns null when no email row is usable (⇒ a silent no-op send).
 */
export function selectEmailSource(cfg: NotificationsConfig): EmailRuntimeConfig | null {
  for (const nf of cfg.notifiers) {
    if (nf.type !== 'email') continue;
    const parsed = emailRuntimeSchema.safeParse(nf.config);
    if (parsed.success) return parsed.data;
  }
  return null;
}

// --- User-facing render ------------------------------------------------------

/** A rendered requester email — subject + both body parts, ready to hand to `sendMail`. */
export interface RequesterMessage {
  subject: string;
  text: string;
  html: string;
}

/**
 * Build the user-facing message for a requester transition. Distinct from the admin `render()`:
 * every link points at the requester's own My Requests page (`/requests`), never `/admin` or
 * `/users`. `baseUrl` is the app's public origin (no trailing slash) or null; a null base yields
 * a link-free message rather than a dead relative link. Switches on `transition` so a new
 * `NotifiableTransition` is a compile error until it's given copy (approved/denied/available).
 * `reason` is the admin's decision note, rendered as a second paragraph on a `denied` message ONLY
 * when supplied — never the requester's own note (issue #131), never shown for other transitions.
 */
export function renderRequesterMessage(
  transition: NotifiableTransition,
  request: { title: string; author: string | null },
  baseUrl: string | null,
  reason?: string | null,
): RequesterMessage {
  const by = request.author ? ` by ${request.author}` : '';
  const { title, body, detail } = ((): { title: string; body: string; detail?: string } => {
    switch (transition) {
      case 'approved':
        return {
          title: 'Your request was approved',
          body: `“${request.title}”${by} was approved and is on its way to your library.`,
        };
      case 'denied':
        return {
          title: 'Your request was declined',
          body: `“${request.title}”${by} was declined.`,
          // Only the admin's decision note surfaces here (never `row.note`), and only when supplied.
          ...(reason ? { detail: `Reason: ${reason}` } : {}),
        };
      case 'available':
        return {
          title: 'Your audiobook is ready',
          body: `“${request.title}”${by} is now available in your library.`,
        };
      default: {
        // Exhaustiveness guard: a new NotifiableTransition without copy here is a compile error.
        const _exhaustive: never = transition;
        return { title: 'Request update', body: String(_exhaustive) };
      }
    }
  })();
  const url = baseUrl ? `${baseUrl}/requests` : null;
  const linkLabel = 'Open My Requests';
  // Body plus an optional reason paragraph (denied only), then the link. Escape EVERY interpolated
  // value at the HTML boundary (href, label, body, reason) rather than reasoning per-value about
  // trust — mirrors the admin EmailChannel's uniform escaping so the message stays injection-proof
  // if PUBLIC_URL (in the href) or an admin's note ever carries a metacharacter.
  const paragraphs = detail ? [body, detail] : [body];
  const link = url ? `<p><a href="${escapeHtml(url)}">${escapeHtml(linkLabel)}</a></p>` : '';
  return {
    subject: title,
    text: [...paragraphs, ...(url ? [url] : [])].join('\n\n'),
    html: `${paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('')}${link}`,
  };
}

// --- The sender --------------------------------------------------------------

export interface RequesterEmailArgs {
  /** The requester's own address (`users.email`) — the ONLY field that differs from the admin path. */
  to: string;
  transition: NotifiableTransition;
  request: { title: string; author: string | null };
  /**
   * The admin's decision note for a `denied` transition (issue #131) — rendered as the denial reason.
   * The ONLY reason source: threaded explicitly from `decision.note`, NEVER the requester's own
   * `row.note`. Omitted for approved/available (no reason line).
   */
  reason?: string;
}

/**
 * Terminal outcome of a requester-email send attempt (issue #121). The poller sweep uses this to
 * decide whether the row is settled: `delivered` → set the marker; `skipped-no-config` → leave the
 * marker null (a GLOBAL, replayable condition — the backlog delivers once the admin configures a
 * usable email notifier). A transient SMTP failure is NOT a value here — it still THROWS, which the
 * sweep treats as "failed, retry next tick".
 */
export type RequesterEmailOutcome = 'delivered' | 'skipped-no-config';

/** The seam RequestService depends on — a plain "send one email to a recipient" contract. */
export interface RequesterEmailSender {
  send(args: RequesterEmailArgs): Promise<RequesterEmailOutcome>;
}

/**
 * Sends a single requester email, building a fresh nodemailer transport at send time from the
 * operator's first usable email notifier (so config can't drift from a rebuilt-on-save singleton,
 * and a few-times/hour path needs no live transport). Returns a typed outcome (issue #121) so the
 * poller sweep can decide whether the row is settled: `skipped-no-config` when no usable source
 * exists (never throws — a GLOBAL replayable condition), `delivered` once `sendMail` completes. An
 * SMTP failure still rejects, which the fire-and-forget sweep catches and retries next tick.
 */
export class RequesterEmailService implements RequesterEmailSender {
  constructor(
    // An ACCESSOR, not a captured config: notifier settings are rebuilt on every Settings save,
    // so read the live decrypted config at send time (mirrors the live-notifier accessor pattern).
    private readonly getConfig: () => Promise<NotificationsConfig>,
  ) {}

  async send(args: RequesterEmailArgs): Promise<RequesterEmailOutcome> {
    const cfg = await this.getConfig();
    const source = selectEmailSource(cfg);
    if (!source) {
      // No usable email notifier — a GLOBAL, replayable skip (the sweep leaves the marker null so
      // the backlog delivers once configured, and logs the prod-visible, publicId-keyed breadcrumb).
      // NEVER log `args.to` (the recipient is PII) — the sweep owns the operator-facing log.
      return 'skipped-no-config';
    }
    const message = renderRequesterMessage(args.transition, args.request, cfg.publicUrl, args.reason ?? null);
    const transport = buildRequesterTransport(source);
    await transport.sendMail({
      from: source.from,
      to: args.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    return 'delivered';
  }
}

/**
 * A fresh nodemailer transport from a selected email source. Mirrors `EmailChannel`'s transport
 * options (bounded timeouts so a dead SMTP server can't leak a pending promise/socket; the auth
 * block omitted for a passwordless / open-relay source). Recipient (`to`) is NOT baked in here —
 * the caller sets it per-send to the requester, never the source notifier's admin `to`.
 */
function buildRequesterTransport(cfg: EmailRuntimeConfig): Transporter {
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    ...(cfg.user && cfg.pass ? { auth: { user: cfg.user, pass: cfg.pass } } : {}),
  });
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}
