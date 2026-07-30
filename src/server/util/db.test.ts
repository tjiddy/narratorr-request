import { describe, it, expect } from 'vitest';
import { SQLITE_CONSTRAINT_UNIQUE, causeChainMessages, hasSqliteRawCode, isUniqueViolation } from './db.js';
// Imported to pin the DELIMITER contract of causeChainMessages from the consumer side:
// `ACTIVE_COLLISION_RE` uses `[^\n]*` precisely so a match cannot straddle two messages.
// If the join ever stopped being newline-delimited, that regex would silently widen.
import { isActiveKindleSendCollision } from '../services/kindle-send.policy.js';
import { createTestDb, drizzleConstraintError, insertUser } from '../test-support/db.js';
import { users } from '../../db/schema.js';
import { publicId } from './ids.js';

/** The param-echo payload: user-controlled text that FORGES the Kindle collision message. */
const FORGED_PARAMS =
  'rq_x,4242,B1,UNIQUE constraint failed: kindle_sends.user_id, kindle_sends.book_id,pending';

describe('causeChainMessages', () => {
  it('joins every message in the chain, one per line', () => {
    expect(causeChainMessages(new Error('outer', { cause: new Error('inner') }))).toBe('outer\ninner\n');
  });

  it('stringifies non-Error values and renders nullish ones as empty', () => {
    expect(causeChainMessages(undefined)).toBe('');
    expect(causeChainMessages(null)).toBe('');
    expect(causeChainMessages('boom')).toBe('boom');
    expect(causeChainMessages(42)).toBe('42');
    expect(causeChainMessages(new Error('outer', { cause: 'raw' }))).toBe('outer\nraw');
  });

  it('caps the walk at depth 5 — the sixth cause is dropped', () => {
    // Chain e0 → e1 → … → e7. e5 sits at depth 5 (walked); e6 at depth 6 (dropped).
    let err = new Error('e7');
    for (let i = 6; i >= 0; i -= 1) err = new Error(`e${i}`, { cause: err });
    expect(causeChainMessages(err)).toBe('e0\ne1\ne2\ne3\ne4\ne5\n');
  });

  it('terminates on a self-referential cause instead of recursing without bound', () => {
    const cyclic = new Error('loop') as Error & { cause: unknown };
    cyclic.cause = cyclic;
    expect(causeChainMessages(cyclic)).toBe('loop\n'.repeat(6));
  });

  it('keeps messages separable — a match cannot straddle two links of the chain', () => {
    // Both halves of the Kindle active-reservation index name are present, but in
    // DIFFERENT messages. The newline join is what keeps that from classifying as a
    // collision; a space-joined chain would make this a false positive.
    //
    // The chain carries a REAL `rawCode: 2067` so the new structural gate is satisfied and
    // the regex's `[^\n]*` anchoring is what does the rejecting. With a message-only chain
    // this case would short-circuit on the gate and go vacuous.
    const split = Object.assign(
      new Error('UNIQUE constraint failed: kindle_sends.user_id', {
        cause: Object.assign(new Error('kindle_sends.book_id'), { rawCode: SQLITE_CONSTRAINT_UNIQUE }),
      }),
      { rawCode: SQLITE_CONSTRAINT_UNIQUE },
    );
    expect(hasSqliteRawCode(split, SQLITE_CONSTRAINT_UNIQUE)).toBe(true);
    expect(isActiveKindleSendCollision(split)).toBe(false);
  });
});

describe('hasSqliteRawCode — the structural chain walk', () => {
  it('names the extended UNIQUE result code', () => {
    expect(SQLITE_CONSTRAINT_UNIQUE).toBe(2067);
  });

  it('matches a rawCode on the top-level link', () => {
    expect(hasSqliteRawCode(Object.assign(new Error('x'), { rawCode: 2067 }), SQLITE_CONSTRAINT_UNIQUE)).toBe(true);
  });

  it('reads rawCode off a PLAIN OBJECT, not only an Error instance', () => {
    // The driver's links are Errors today, but the walk must not silently stop at a link
    // some future wrapper hands over as a bare object.
    expect(hasSqliteRawCode({ rawCode: 2067 }, SQLITE_CONSTRAINT_UNIQUE)).toBe(true);
  });

  it('traverses THROUGH a non-Error object link to reach the code beyond it', () => {
    const chain = new Error('outer', { cause: { cause: Object.assign(new Error('inner'), { rawCode: 2067 }) } });
    expect(hasSqliteRawCode(chain, SQLITE_CONSTRAINT_UNIQUE)).toBe(true);
  });

  it('reads an INHERITED rawCode (plain property access, not hasOwnProperty)', () => {
    const link = Object.create({ rawCode: 2067 }) as object;
    expect(Object.hasOwn(link, 'rawCode')).toBe(false); // the property is on the prototype only
    expect(hasSqliteRawCode(link, SQLITE_CONSTRAINT_UNIQUE)).toBe(true);
  });

  it('never matches a NON-NUMERIC rawCode — no coercion', () => {
    expect(hasSqliteRawCode({ rawCode: '2067' }, SQLITE_CONSTRAINT_UNIQUE)).toBe(false);
    expect(hasSqliteRawCode({ rawCode: null }, SQLITE_CONSTRAINT_UNIQUE)).toBe(false);
    expect(hasSqliteRawCode({ rawCode: { valueOf: () => 2067 } }, SQLITE_CONSTRAINT_UNIQUE)).toBe(false);
  });

  it('does not match a different code', () => {
    expect(hasSqliteRawCode(drizzleConstraintError({ rawCode: 787, code: 'X', driverMessage: 'y' }), 2067)).toBe(false);
  });

  it('tolerates nullish, primitive and non-Error inputs without throwing', () => {
    for (const value of [undefined, null, 'boom', 42, true, Symbol('s')]) {
      expect(hasSqliteRawCode(value, SQLITE_CONSTRAINT_UNIQUE)).toBe(false);
    }
  });

  it('is bounded exactly like causeChainMessages — depth 5 is walked, depth 6 is not', () => {
    // Chain l0 → … → l7 where ONLY the deepest link carries the code.
    const buildChain = (codedIndex: number): Error => {
      let err = Object.assign(new Error('l7'), codedIndex === 7 ? { rawCode: 2067 } : {});
      for (let i = 6; i >= 0; i -= 1) {
        err = Object.assign(new Error(`l${i}`, { cause: err }), i === codedIndex ? { rawCode: 2067 } : {});
      }
      return err;
    };
    expect(hasSqliteRawCode(buildChain(5), SQLITE_CONSTRAINT_UNIQUE)).toBe(true);
    expect(hasSqliteRawCode(buildChain(7), SQLITE_CONSTRAINT_UNIQUE)).toBe(false);
  });

  it('terminates on a self-referential cause instead of recursing without bound', () => {
    const cyclic = new Error('loop') as Error & { cause: unknown };
    cyclic.cause = cyclic;
    expect(hasSqliteRawCode(cyclic, SQLITE_CONSTRAINT_UNIQUE)).toBe(false);
  });
});

describe('isUniqueViolation', () => {
  it('classifies a REAL drizzle/libSQL duplicate insert as a unique violation', async () => {
    const db = await createTestDb();
    await insertUser(db, { provider: 'local', subject: 'a@b.com' });

    let caught: unknown;
    try {
      await db
        .insert(users)
        .values({ publicId: publicId('us'), authProvider: 'local', authSubject: 'a@b.com', username: 'dupe' })
        .returning();
    } catch (err: unknown) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(isUniqueViolation(caught)).toBe(true);

    // Pin the SHAPE the fix depends on: drizzle's own wrapper message never names the
    // constraint — only the cause does. A future driver/ORM upgrade that moves the text
    // back onto the top-level message should fail here loudly rather than quietly
    // re-inert the classifier.
    expect((caught as Error).message).not.toMatch(/UNIQUE constraint failed/i);
    expect(causeChainMessages((caught as Error).cause)).toMatch(/UNIQUE constraint failed/i);

    // And pin the STRUCTURAL shape the classification now keys on: the chain carries the
    // extended result code. A driver upgrade that drops or renumbers `rawCode` fails here
    // rather than silently re-inerting both race-resolution paths.
    expect((caught as { cause?: { rawCode?: unknown } }).cause?.rawCode).toBe(2067);
    expect(hasSqliteRawCode(caught, SQLITE_CONSTRAINT_UNIQUE)).toBe(true);
  });

  it('walks the whole cause chain structurally, not just the top-level link', () => {
    // The real 3-level drizzle shape: the code lives two links down, and the wrapper's own
    // message names no constraint at all.
    const wrapped = drizzleConstraintError({
      rawCode: SQLITE_CONSTRAINT_UNIQUE,
      code: 'SQLITE_CONSTRAINT_UNIQUE',
      driverMessage: 'UNIQUE constraint failed: users.auth_provider, users.auth_subject',
      table: 'users',
    });
    expect(wrapped.message).not.toMatch(/UNIQUE constraint failed/i);
    expect(isUniqueViolation(wrapped)).toBe(true);
  });

  it.each([
    ['a CHECK breach', 275, 'SQLITE_CONSTRAINT_CHECK', 'CHECK constraint failed: requests_status'],
    ['a FOREIGN KEY breach', 787, 'SQLITE_CONSTRAINT_FOREIGNKEY', 'FOREIGN KEY constraint failed'],
    ['a NOT NULL breach', 1299, 'SQLITE_CONSTRAINT_NOTNULL', 'NOT NULL constraint failed: requests.title'],
    ['a PRIMARY KEY breach', 1555, 'SQLITE_CONSTRAINT_PRIMARYKEY', 'UNIQUE constraint failed: requests.id'],
  ] as const)(
    'does NOT classify %s as a unique violation — it surfaces to the caller instead',
    (_label, rawCode, code, driverMessage) => {
      // Inverts the old `documents the broad SQLITE_CONSTRAINT arm` pin: these no longer
      // enter the race-resolution re-query path at all.
      expect(isUniqueViolation(drizzleConstraintError({ rawCode, code, driverMessage }))).toBe(false);
    },
  );

  it('NO LONGER classifies on message text alone — a bare UNIQUE message is false now', () => {
    // Deliberate compatibility break (#195): without the structural code this is
    // indistinguishable from an echoed parameter value.
    expect(isUniqueViolation(new Error('UNIQUE constraint failed: requests.user_id, requests.asin'))).toBe(false);
  });

  it('NO LONGER classifies a bare SQLITE_CONSTRAINT message — false now', () => {
    expect(isUniqueViolation(new Error('SQLITE_CONSTRAINT: ...'))).toBe(false);
  });

  it('does not match a plain non-constraint error', () => {
    expect(isUniqueViolation(new Error('boom'))).toBe(false);
  });

  it('classifies a non-Error value without throwing — the raw string form is false now', () => {
    expect(isUniqueViolation('UNIQUE constraint failed: x')).toBe(false);
    expect(isUniqueViolation('boom')).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
  });

  it('rejects a FORGED unique message echoed through the wrapper’s params line', () => {
    // The defect this narrowing closes: drizzle's wrapper message embeds the statement's
    // `params:` line, so a user-controlled column value containing the constraint text used
    // to classify as a unique violation. The chain's real code says FOREIGN KEY.
    const forged = drizzleConstraintError({
      rawCode: 787,
      code: 'SQLITE_CONSTRAINT_FOREIGNKEY',
      driverMessage: 'FOREIGN KEY constraint failed',
      params: FORGED_PARAMS,
    });
    expect(causeChainMessages(forged)).toMatch(/UNIQUE constraint failed: kindle_sends\.user_id/);
    expect(isUniqueViolation(forged)).toBe(false);
    expect(isActiveKindleSendCollision(forged)).toBe(false);
  });

  it('classifies a RangeError as not-a-unique-violation (guards the race path)', () => {
    // A RangeError is a value/programmer error, never a constraint breach — it must not
    // be swallowed by the insert-time race-resolution catch.
    expect(isUniqueViolation(new RangeError('out of range'))).toBe(false);
  });

  it('short-circuits a RangeError BEFORE the chain walk, whatever the cause carries', () => {
    // The guard must precede the walk: the structural walk reaches PAST the top-level value
    // into the chain, which here carries a genuine 2067. Without the guard this classifies
    // true and the race path swallows a real value error.
    const range = new RangeError('out of range', {
      cause: drizzleConstraintError({
        rawCode: SQLITE_CONSTRAINT_UNIQUE,
        code: 'SQLITE_CONSTRAINT_UNIQUE',
        driverMessage: 'UNIQUE constraint failed: users.auth_provider, users.auth_subject',
        table: 'users',
      }),
    });
    expect(hasSqliteRawCode(range, SQLITE_CONSTRAINT_UNIQUE)).toBe(true); // the walk DOES reach it
    expect(isUniqueViolation(range)).toBe(false); // …and the guard still wins
  });

  it('terminates on a self-referential cause chain', () => {
    const cyclic = new Error('boom') as Error & { cause: unknown };
    cyclic.cause = cyclic;
    expect(isUniqueViolation(cyclic)).toBe(false);
  });

  it('does not reach a code buried past the depth cap', () => {
    let err = Object.assign(new Error('l7'), { rawCode: SQLITE_CONSTRAINT_UNIQUE });
    for (let i = 6; i >= 0; i -= 1) err = Object.assign(new Error(`l${i}`, { cause: err }), {});
    expect(isUniqueViolation(err)).toBe(false);
  });
});
