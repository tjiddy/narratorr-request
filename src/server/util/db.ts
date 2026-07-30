/**
 * Every message in an error's CAUSE CHAIN, one per line.
 *
 * Walking the chain is required, not defensive: drizzle wraps a rejected statement in a
 * `Failed query: insert into "…" …` error and hangs the libSQL error — the one that
 * actually names the constraint — off `cause`. A classifier that read only `err.message`
 * would never match a REAL collision, only a synthetic one in a unit test.
 *
 * The NEWLINE delimiter is part of the contract: consumers anchor with `[^\n]*` so a match
 * cannot straddle two links of the chain (see `ACTIVE_COLLISION_RE` in
 * `services/kindle-send.policy.ts`).
 */
export function causeChainMessages(err: unknown, depth = 0): string {
  if (depth > 5) return '';
  if (!(err instanceof Error)) return err === null || err === undefined ? '' : String(err);
  return `${err.message}\n${causeChainMessages(err.cause, depth + 1)}`;
}

/**
 * Whether an error is a SQLite unique-constraint breach, as surfaced by libSQL.
 *
 * Shared by the insert-time race-resolution catch in both `RequestService` and
 * `UserService`: when the partial-unique index fires between a preflight de-dupe and
 * the insert, the catch re-queries and resolves to the existing row instead of
 * creating a duplicate. Both services classify the breach the same way, so the check
 * lives here once (DRY).
 *
 * Matched against the whole CAUSE CHAIN, not `err.message`: a real drizzle rejection names
 * the constraint only on the nested libSQL error, so the message-only form this replaced
 * classified every genuine breach as `false` and left both race-resolution catches inert.
 *
 * A `RangeError` is short-circuited to `false` BEFORE the walk: it's a programmer/value
 * error (e.g. a value out of range), never a constraint breach, and must not be swallowed
 * by the race-resolution path. Non-`Error` throws are stringified so they classify without
 * throwing.
 *
 * NOTE: the `SQLITE_CONSTRAINT` arm is intentionally broad — it also matches FK / CHECK
 * / NOT-NULL breaches, not only `SQLITE_CONSTRAINT_UNIQUE`. Before the cause-chain fix it
 * matched nothing in production; it is now genuinely REACHABLE from real driver errors, so
 * a misclassified non-unique breach does reach the re-query path — where it finds no row
 * and the original error is rethrown unchanged. Narrowing it (to route only unique breaches
 * into the re-query path) would be a deliberate, test-visible change.
 */
export function isUniqueViolation(err: unknown): boolean {
  if (err instanceof RangeError) return false;
  const msg = causeChainMessages(err);
  return /UNIQUE constraint failed/i.test(msg) || /SQLITE_CONSTRAINT/i.test(msg);
}
