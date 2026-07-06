import type { RequestRow } from '../../db/schema.js';
import type { Notifier } from './notifications/index.js';
import { redact } from './notifications/redact.js';
import type { NotifierLogger } from './notifications/types.js';
import type { RequesterEmailSender } from './notifications/requester-email.js';
import type { UserService } from './user.service.js';

/**
 * Fire-and-forget `request.failed` admin heads-up (issue #60), split out of the state machine in
 * `request.service.ts` (its own concern; keeps that file focused + under the line cap). It NEVER
 * throws into the request/poll path — the transition is already committed before it runs, so a
 * missing requester / dispatch hiccup must never unwind it. (The requester `available` email moved
 * off this fire-and-forget path onto the durable poller sweep in `request.service.ts`, issue #121.)
 */

/**
 * Wiring for the notification side effects — the admin-facing `request.failed` heads-up (issue #60)
 * AND the requester-facing `available` email (issue #50, delivered by the poller sweep since #121).
 * Optional as a whole at the service — when absent nothing is emitted (existing 3-arg constructions
 * keep working).
 */
export interface RequestFailureNotifyDeps {
  /**
   * Reads the CURRENT notifier at call time. MUST be an accessor, not a captured
   * instance: the live notifier is rebuilt and reassigned on every notifier-settings
   * change, so capturing it would dispatch failed-notifications through a stale channel set.
   */
  getNotifier: () => Notifier;
  /** Resolves `requester.username` for the `request.failed` admin heads-up; an absent row is a no-op. */
  users: Pick<UserService, 'getById'>;
  /**
   * Requester-email sender (issue #50). Optional — when absent, `available` rows are settled without
   * an email by the poller sweep (`RequestService.sweepAvailableNotifications`), which is the SOLE
   * sender since #121 (the failed path is unaffected). The sender builds its SMTP transport from the
   * operator's first usable email notifier at send time; no usable source is a typed replayable skip.
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
