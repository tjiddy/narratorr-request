/**
 * The frozen Send-to-Kindle policy (issue #148): the constants, and the pure decisions taken over
 * them. Separate from both the service and the transport so every boundary case is assertable as a
 * unit — the exact window cutoffs, the `sizeBytes` admissibility table, the lease clamp and the
 * collision classifier are all decisions a test should be able to make without a socket or a DB.
 */

import { SQLITE_CONSTRAINT_UNIQUE, causeChainMessages, hasSqliteRawCode } from '../util/db.js';

/** Hard cap on the RAW upstream EPUB we will ship. Amazon's own personal-document limit. */
export const MAX_KINDLE_SEND_BYTES = 25 * 1024 * 1024;

/** Starts per user per ROLLING minute. In-memory only — a restart resets it, by design. */
export const KINDLE_SEND_STARTS_PER_MINUTE = 3;
/** The per-minute window, named so the deque and any test assert the same number. */
export const KINDLE_SEND_START_WINDOW_MS = 60_000;
/** Accepted (`sent`) sends per user per rolling 24h, derived from the audit rows. */
export const KINDLE_SEND_DAILY_ACCEPTED = 10;
export const KINDLE_SEND_DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;
/** A terminal attempt for the same book suppresses a re-send for this long. */
export const KINDLE_SEND_REPLAY_WINDOW_MS = 60_000;
/** How long a `started` reservation stays live before a sweep may converge it. */
export const KINDLE_SEND_LEASE_MS = 10 * 60_000;
/**
 * The SEND BUDGET — how long we keep feeding bytes. Strictly below {@link KINDLE_SEND_LEASE_MS},
 * which is load-bearing: it is what stops a reservation being fed past its own lease. It does NOT
 * bound the critical section, which has no absolute wall-clock bound because the post-DATA SMTP
 * window and every database call are uncancellable. Any claim of a finite worst-case section
 * duration would be false.
 */
export const KINDLE_SEND_ATTEMPT_DEADLINE_MS = 300_000;
/** Terminal audit rows older than this are pruned opportunistically during a send. */
export const KINDLE_SEND_AUDIT_RETENTION_DAYS = 90;
export const KINDLE_SEND_AUDIT_RETENTION_MS = KINDLE_SEND_AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/**
 * ONE WINDOW CONVENTION for all four rolling windows — the per-minute start cap, the replay window,
 * the daily accepted quota and the reservation lease. A record aged EXACTLY the window length is
 * INSIDE the window: the predicate is `timestamp >= now - WINDOW_MS`, so the complementary
 * "expired" predicate is the strict `timestamp < now - WINDOW_MS`. Stating it once, here, is what
 * stops the four boundaries drifting apart.
 */
export const isInsideWindow = (timestampMs: number, nowMs: number, windowMs: number): boolean =>
  timestampMs >= nowMs - windowMs;

/**
 * The POLICY admissibility of an advertised `sizeBytes`, kept OUT of the vendored contract on
 * purpose: `v1CompanionEbookSchema.sizeBytes` stays a bare `z.number()` (narratorr deliberately
 * round-trips `0`), while integrity verification is meaningless against a value that is not a byte
 * count. `0` is admissible and must NOT be falsy-coerced into "missing"; exactly `MAX` is admitted
 * and `MAX + 1` is not.
 */
export function admitSizeBytes(sizeBytes: number): 'ok' | 'unavailable' | 'too_large' {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) return 'unavailable';
  return sizeBytes > MAX_KINDLE_SEND_BYTES ? 'too_large' : 'ok';
}

/**
 * The armed send budget, CLAMPED to the reservation's remaining lease.
 *
 * `KINDLE_SEND_ATTEMPT_DEADLINE_MS < KINDLE_SEND_LEASE_MS` alone does not prove the invariant: the
 * lease starts when the INSERT executes, while the deadline is armed only once the request
 * OBSERVES that insert, and nothing bounds that gap. A statement durable at T0 that settles at
 * T0+6m would otherwise run a full five-minute send to T0+11m on a row a sweep may converge at
 * T0+10m. Clamping makes "a reservation is never fed bytes past its own lease" true by
 * construction. A value `<= 0` means there is no usable window at all — the attempt finalizes
 * immediately and no upstream connection is opened.
 */
export function sendBudgetMs(input: {
  nowMs: number;
  reservationStartedAtMs: number;
  attemptDeadlineMs?: number;
}): number {
  const leaseRemaining = input.reservationStartedAtMs + KINDLE_SEND_LEASE_MS - input.nowMs;
  return Math.min(input.attemptDeadlineMs ?? KINDLE_SEND_ATTEMPT_DEADLINE_MS, leaseRemaining);
}

/**
 * Whether an insert error is the ACTIVE-RESERVATION unique collision specifically.
 *
 * Deliberately NOT `isUniqueViolation()`: that helper answers "is this a unique breach at all",
 * and a unique breach on ANY OTHER index of the same insert is not THIS collision — reporting
 * one to the user as `rate_limited` would mask it. So the table and both indexed columns still
 * have to be matched by name, which only the message text carries; every other insert error is
 * an operational failure and takes the pre-reservation 500 path.
 */
const ACTIVE_COLLISION_RE =
  /UNIQUE constraint failed:[^\n]*\bkindle_sends\.user_id\b[^\n]*\bkindle_sends\.book_id\b/i;

/**
 * Gated on the structural code FIRST, then the target regex — both must hold.
 *
 * The structural gate is DEFENSE IN DEPTH on this exported function, not a fix to a reachable
 * caller defect. drizzle's wrapper message embeds the statement's echoed `params:` line, so a
 * user-controlled value containing the collision text can forge the regex; `reserve()` — the sole
 * production caller — inserts only numeric ids, the literal `'started'`, timestamps, nulls and a
 * `bookId` already constrained to `^bk_[A-Za-z0-9_-]{1,61}$`, a grammar with no space, colon or
 * dot, so ITS params line cannot carry the text. The gate is what keeps the classifier exact if
 * it is ever called on an error from a different insert.
 */
export function isActiveKindleSendCollision(err: unknown): boolean {
  // A RangeError is a value/programmer error, never a constraint breach. Load-bearing, and
  // evaluated first: the structural walk reaches past the top-level value into the chain.
  if (err instanceof RangeError) return false;
  if (!hasSqliteRawCode(err, SQLITE_CONSTRAINT_UNIQUE)) return false;
  return ACTIVE_COLLISION_RE.test(causeChainMessages(err));
}
