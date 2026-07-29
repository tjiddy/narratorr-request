/**
 * The frozen Send-to-Kindle policy (issue #148): the constants, and the pure decisions taken over
 * them. Separate from both the service and the transport so every boundary case is assertable as a
 * unit — the exact window cutoffs, the `sizeBytes` admissibility table, the lease clamp and the
 * collision classifier are all decisions a test should be able to make without a socket or a DB.
 */

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
 * Deliberately NOT `isUniqueViolation()`: that helper treats every `SQLITE_CONSTRAINT` — foreign
 * key, CHECK and NOT NULL included — as a unique breach, so reusing it here would report genuine
 * corruption or a programmer error to the user as `rate_limited`. Matching the table AND both
 * indexed columns keeps the classification target-specific; every other insert error is an
 * operational failure and takes the pre-reservation 500 path.
 */
const ACTIVE_COLLISION_RE =
  /UNIQUE constraint failed:[^\n]*\bkindle_sends\.user_id\b[^\n]*\bkindle_sends\.book_id\b/i;

/**
 * Every message in an error's CAUSE CHAIN, one per line.
 *
 * Walking the chain is required, not defensive: drizzle wraps a rejected statement in a
 * `Failed query: insert into "kindle_sends" …` error and hangs the libSQL error — the one that
 * actually names the constraint — off `cause`. A classifier that read only `err.message` would
 * never match a REAL collision, only a synthetic one in a unit test.
 */
function causeChainMessages(err: unknown, depth = 0): string {
  if (depth > 5) return '';
  if (!(err instanceof Error)) return err === null || err === undefined ? '' : String(err);
  return `${err.message}\n${causeChainMessages(err.cause, depth + 1)}`;
}

export function isActiveKindleSendCollision(err: unknown): boolean {
  // A RangeError is a value/programmer error, never a constraint breach.
  if (err instanceof RangeError) return false;
  return ACTIVE_COLLISION_RE.test(causeChainMessages(err));
}
