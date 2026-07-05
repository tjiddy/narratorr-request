import type { RequestRow } from '../../db/schema.js';
import type { Notifier } from './notifications/index.js';
import { redact } from './notifications/redact.js';
import type { NotifierLogger } from './notifications/types.js';
import type { RequesterEmailSender } from './notifications/requester-email.js';
import type { UserService } from './user.service.js';
import { sanitizeNotifyOn } from '../../shared/schemas/user.js';

/**
 * Fire-and-forget notification side effects the request lifecycle emits, split out of the state
 * machine in `request.service.ts` (its own concern; keeps that file focused + under the line cap).
 * Both emitters NEVER throw into the request/poll path — the transition is already committed before
 * they run, so a missing requester / dispatch hiccup / send fault must never unwind it.
 */

/**
 * Wiring for the notification side effects — the admin-facing `request.failed` heads-up (issue #60)
 * AND the requester-facing `available` email (issue #50). Optional as a whole at the service — when
 * absent nothing is emitted (existing 3-arg constructions keep working).
 */
export interface RequestFailureNotifyDeps {
  /**
   * Reads the CURRENT notifier at call time. MUST be an accessor, not a captured
   * instance: the live notifier is rebuilt and reassigned on every notifier-settings
   * change, so capturing it would dispatch failed-notifications through a stale channel set.
   */
  getNotifier: () => Notifier;
  /** Resolves `requester.username` (failed) / the requester's opt-in + email (available); an absent row is a no-op. */
  users: Pick<UserService, 'getById'>;
  /**
   * Requester-email sender (issue #50). Optional — when absent, `available` transitions emit no
   * requester email (the failed path is unaffected). Builds its SMTP transport from the operator's
   * first usable email notifier at send time; a missing source is its own silent no-op.
   */
  requesterEmail?: RequesterEmailSender;
  /**
   * Optional log sink for fire-and-forget emission faults (a requester lookup that rejects, or a
   * notifier dispatch that rejects). Without it a lost notification is undiagnosable; the emission
   * stays non-blocking either way — these are breadcrumbs, never thrown to the caller.
   */
  logger?: NotifierLogger;
}

/** Username used when the requester row is gone (e.g. deleted account) — the admin still hears it failed. */
const UNKNOWN_REQUESTER = '(unknown requester)';

/**
 * Fire-and-forget `request.failed` emission. Resolves the requester via the live UserService and
 * dispatches through the LIVE notifier (read at call time). A missing requester row still emits
 * with a stable placeholder username — the admin needs to hear it failed. No deps → no-op.
 */
export function emitFailed(deps: RequestFailureNotifyDeps | undefined, row: RequestRow, reason: string | null): void {
  if (!deps) return;
  void (async () => {
    // A requester lookup fault (DB fault) must NOT lose the notification — the admin still
    // needs to hear it failed. Log a redacted breadcrumb and fall back to the placeholder.
    let requester: { username: string } | undefined;
    try {
      requester = await deps.users.getById(row.userId);
    } catch (err) {
      // redact() before logging: a lookup fault's error text could embed a secret-bearing value.
      deps.logger?.warn(
        { err: redact(err), request: row.publicId },
        'request.failed: requester lookup failed; emitting with placeholder username',
      );
    }
    try {
      await deps.getNotifier().notify({
        event: 'request.failed',
        request: { publicId: row.publicId, title: row.title, author: row.author, asin: row.asin, coverUrl: row.coverUrl },
        requester: { username: requester?.username ?? UNKNOWN_REQUESTER },
        reason,
      });
    } catch (err) {
      // A lost notification must be diagnosable. The failed transition already committed; never
      // propagate. redact() before logging: a dispatch error can embed a webhook URL / token.
      deps.logger?.warn(
        { err: redact(err), request: row.publicId },
        'request.failed: notifier dispatch failed; notification lost',
      );
    }
  })().catch((err) => {
    // Final backstop: both awaits above are individually guarded, so this only fires on a truly
    // unexpected throw. The failed transition already landed; swallow into a (redacted) breadcrumb.
    deps.logger?.warn({ err: redact(err), request: row.publicId }, 'request.failed: emission failed unexpectedly');
  });
}

/**
 * Fire-and-forget requester `available` email (issue #50). Called only when an available atomic
 * claim landed a row, so it fires EXACTLY ONCE per transition. Resolves the requester at send time
 * (opt-in + contact live on their row and can have changed): a missing row / not-opted-in / null
 * email are all valid SILENT no-ops. No deps or no requester sender → no-op.
 */
export function emitAvailable(deps: RequestFailureNotifyDeps | undefined, row: RequestRow): void {
  const sender = deps?.requesterEmail;
  if (!deps || !sender) return;
  void (async () => {
    let user: Awaited<ReturnType<typeof deps.users.getById>>;
    try {
      user = await deps.users.getById(row.userId);
    } catch (err) {
      // redact() before logging: a lookup fault's error text could embed a secret-bearing value.
      deps.logger?.warn({ err: redact(err), request: row.publicId }, 'request.available: requester lookup failed; skipping email');
      return;
    }
    if (!user) return; // requester row gone (deleted account) — nothing to email
    if (!sanitizeNotifyOn(user.notifyOn).includes('available')) return; // not opted in
    if (!user.email) return; // opted in but no contact — a valid silent no-op (Design #4)
    try {
      await sender.send({ to: user.email, transition: 'available', request: { title: row.title, author: row.author } });
    } catch (err) {
      // A lost requester email must be diagnosable; the available transition already committed,
      // never propagate. redact() before logging: a send fault can embed SMTP credentials.
      deps.logger?.warn(
        { err: redact(err), request: row.publicId },
        'request.available: requester email dispatch failed; notification lost',
      );
    }
  })().catch((err) => {
    deps.logger?.warn({ err: redact(err), request: row.publicId }, 'request.available: emission failed unexpectedly');
  });
}
