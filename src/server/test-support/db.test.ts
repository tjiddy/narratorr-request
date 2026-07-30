import { describe, it, expect } from 'vitest';
import { drizzleConstraintError, realDuplicateInsertError } from './db.js';
import { SQLITE_CONSTRAINT_UNIQUE } from '../util/db.js';

// The drizzle-shaped constraint fixture's CONTRACT, pinned directly — the sibling of
// `fake-smtp.test.ts` and `route-harness.test.ts`.
//
// `drizzleConstraintError()` promises the real 3-level driver chain (issue #195), but every
// classifier that consumes it can be satisfied by L1 alone: `hasSqliteRawCode()` stops at the
// first link carrying a numeric `rawCode`, and `causeChainMessages()` already has the constraint
// text by L1. So deleting the inner sqlite error, or giving it the wrong code spelling, leaves
// EVERY test in `util/db.test.ts`, `user.service.test.ts`, `request.service.test.ts` and
// `kindle-send.service.test.ts` green while the fixture silently stops modelling the driver.
//
// Diffing against a real rejection is the load-bearing half: asserting the factory against
// literals alone only proves it matches ITSELF.

/** The `(message, code, rawCode)` triple of every link of a cause chain, outermost first. */
function chainShape(err: unknown): Array<{ message: unknown; code: unknown; rawCode: unknown }> {
  const levels: Array<{ message: unknown; code: unknown; rawCode: unknown }> = [];
  let link: unknown = err;
  while (link !== null && typeof link === 'object' && levels.length < 6) {
    const l = link as { message?: unknown; code?: unknown; rawCode?: unknown; cause?: unknown };
    levels.push({ message: l.message, code: l.code, rawCode: l.rawCode });
    link = l.cause;
  }
  return levels;
}

describe('drizzleConstraintError — the synthetic driver shape the classifier suites rest on', () => {
  const DRIVER_MESSAGE = 'UNIQUE constraint failed: users.auth_provider, users.auth_subject';
  const built = drizzleConstraintError({
    rawCode: SQLITE_CONSTRAINT_UNIQUE,
    code: 'SQLITE_CONSTRAINT_UNIQUE',
    driverMessage: DRIVER_MESSAGE,
    table: 'users',
    params: 'us_x,local,a@b.com,dupe',
  });

  it('builds all THREE levels, each carrying exactly the fields its real counterpart does', () => {
    const [l0, l1, l2, ...beyond] = chainShape(built);
    expect(beyond).toEqual([]); // exactly three links — no deeper tail

    // L0 — drizzle's own wrapper: the statement plus the echoed params, and NO driver fields.
    // Its message must NOT name the constraint; that asymmetry is the whole param-echo defect.
    expect(l0?.message).toContain('Failed query: insert into "users"');
    expect(l0?.message).toContain('\nparams: us_x,local,a@b.com,dupe');
    expect(l0?.message).not.toMatch(/UNIQUE constraint failed/);
    expect(l0?.code).toBeUndefined();
    expect(l0?.rawCode).toBeUndefined();

    // L1 — libSQL's wrapper: the GENERIC code spelling, prefixed message, extended rawCode.
    expect(l1).toEqual({
      message: `SQLITE_CONSTRAINT: ${DRIVER_MESSAGE}`,
      code: 'SQLITE_CONSTRAINT',
      rawCode: SQLITE_CONSTRAINT_UNIQUE,
    });

    // L2 — the inner sqlite error: the EXTENDED code spelling, the bare driver message, and the
    // SAME rawCode. This is the link no classifier test would miss if it vanished.
    expect(l2).toEqual({
      message: DRIVER_MESSAGE,
      code: 'SQLITE_CONSTRAINT_UNIQUE',
      rawCode: SQLITE_CONSTRAINT_UNIQUE,
    });
  });

  it('reproduces what a REAL libSQL duplicate insert produces, level for level', async () => {
    const realShape = chainShape(await realDuplicateInsertError());
    expect(realShape).toHaveLength(3);

    // L1 and L2 must match the factory EXACTLY — same messages, same spellings, same codes.
    expect(realShape.slice(1)).toEqual(chainShape(built).slice(1));

    // L0 differs only in the generated SQL/params text; its FIELD shape must still agree.
    expect(realShape[0]?.code).toBeUndefined();
    expect(realShape[0]?.rawCode).toBeUndefined();
    expect(realShape[0]?.message).toMatch(/^Failed query: insert into "users"/);
    expect(realShape[0]?.message).toMatch(/\nparams: /);
  });
});
