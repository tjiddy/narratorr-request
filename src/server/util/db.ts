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
 * SQLite's EXTENDED result code for a unique-index breach — `SQLITE_CONSTRAINT_UNIQUE`,
 * i.e. `19 | (8 << 8)`. libSQL exposes it as `rawCode` on the driver error (and on its own
 * `LibsqlError` wrapper), alongside the GENERIC `code: 'SQLITE_CONSTRAINT'` string that does
 * not distinguish one constraint class from another.
 *
 * Equality with this value therefore EXCLUDES the other constraint classes reachable from this
 * repository's tables: `275` CHECK, `787` FOREIGNKEY, `1299` NOTNULL, `1555` PRIMARYKEY. That
 * is a relevance list, not an inventory — SQLite defines further `SQLITE_CONSTRAINT_*` extended
 * codes (`531` COMMITHOOK, `1043` FUNCTION, `1811` TRIGGER, `2323` VTAB, `2579` ROWID,
 * `2835` PINNED, `3091` DATATYPE), all equally excluded by the equality.
 */
export const SQLITE_CONSTRAINT_UNIQUE = 2067;

/**
 * Whether any link of an error's CAUSE CHAIN carries this SQLite extended result code.
 *
 * The STRUCTURAL counterpart to {@link causeChainMessages}, and for the same reason: the code
 * lives on the nested driver error, never on drizzle's wrapper. Reading `rawCode` rather than
 * the `code` string is what makes the match exact — the chain spells the same breach two ways
 * (`SQLITE_CONSTRAINT` on libSQL's wrapper, `SQLITE_CONSTRAINT_UNIQUE` on the inner error) while
 * `rawCode` is identical on both — and immune to message text, which drizzle contaminates with
 * the statement's echoed `params:` line.
 *
 * Reads the property off ANY non-null object link, not only an `instanceof Error`, and only ever
 * matches a `number`: a string `'2067'` is not a match. Bounded at `depth > 5` exactly like the
 * message walk, so a cyclic or over-deep chain terminates.
 */
export function hasSqliteRawCode(err: unknown, rawCode: number, depth = 0): boolean {
  if (depth > 5) return false;
  if (err === null || typeof err !== 'object') return false;
  const link = err as { rawCode?: unknown; cause?: unknown };
  if (typeof link.rawCode === 'number' && link.rawCode === rawCode) return true;
  return hasSqliteRawCode(link.cause, rawCode, depth + 1);
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
 * Decided STRUCTURALLY, over the whole CAUSE CHAIN: the classification is `rawCode ===`
 * {@link SQLITE_CONSTRAINT_UNIQUE} on some link (a real drizzle rejection carries the code only
 * on the nested libSQL error). Message text can NO LONGER influence it at all — which is the
 * point: drizzle's wrapper message embeds the statement's echoed `params:` line, so a
 * user-supplied column value literally containing `UNIQUE constraint failed: …` used to forge a
 * match. A bare `new Error('UNIQUE constraint failed: …')` with no `rawCode` is `false`.
 *
 * Non-unique constraint breaches — FK (787), CHECK (275), NOT NULL (1299), PRIMARY KEY (1555) —
 * are `false` and surface to the caller unchanged instead of routing into the race-resolution
 * re-query path. PRIMARY KEY is excluded deliberately: both race targets are unique INDEXES, and
 * `id` is an autoincrement PK these inserts never supply, so a PK breach is corruption.
 *
 * A `RangeError` is short-circuited to `false` BEFORE the walk, and that guard is LOAD-BEARING,
 * not belt-and-braces: the structural walk reaches past the top-level value into the chain, so
 * a `RangeError` wrapping a genuine 2067 driver error would otherwise classify `true`. A
 * value/programmer error must never be swallowed by the race-resolution path. Non-`Error`
 * throws carry no `rawCode` and classify `false` without throwing.
 */
export function isUniqueViolation(err: unknown): boolean {
  if (err instanceof RangeError) return false;
  return hasSqliteRawCode(err, SQLITE_CONSTRAINT_UNIQUE);
}
