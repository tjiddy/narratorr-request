import { describe, it, expect } from 'vitest';
import { causeChainMessages, isUniqueViolation } from './db.js';
// Imported to pin the DELIMITER contract of causeChainMessages from the consumer side:
// `ACTIVE_COLLISION_RE` uses `[^\n]*` precisely so a match cannot straddle two messages.
// If the join ever stopped being newline-delimited, that regex would silently widen.
import { isActiveKindleSendCollision } from '../services/kindle-send.policy.js';
import { createTestDb, insertUser } from '../test-support/db.js';
import { users } from '../../db/schema.js';
import { publicId } from './ids.js';

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
    const split = new Error('UNIQUE constraint failed: kindle_sends.user_id', {
      cause: new Error('kindle_sends.book_id'),
    });
    expect(isActiveKindleSendCollision(split)).toBe(false);
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
  });

  it('walks the whole cause chain, not just the top-level message', () => {
    const wrapped = new Error('outer', {
      cause: new Error('mid', {
        cause: new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed: t.c'),
      }),
    });
    expect(isUniqueViolation(wrapped)).toBe(true);
  });

  it('classifies a RangeError as not-a-unique-violation (guards the race path)', () => {
    // A RangeError is a value/programmer error, never a constraint breach — it must not
    // be swallowed by the insert-time race-resolution catch.
    expect(isUniqueViolation(new RangeError('out of range'))).toBe(false);
  });

  it('short-circuits a RangeError BEFORE the chain walk, whatever the cause says', () => {
    // The guard must precede the walk: a chain scan that ran first would classify this
    // true and let the race path swallow a genuine value error.
    const range = new RangeError('out of range', {
      cause: new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed: users.auth_provider'),
    });
    expect(isUniqueViolation(range)).toBe(false);
  });

  it('terminates on a self-referential cause chain', () => {
    const cyclic = new Error('boom') as Error & { cause: unknown };
    cyclic.cause = cyclic;
    expect(isUniqueViolation(cyclic)).toBe(false);
  });

  it('matches the libSQL UNIQUE constraint message', () => {
    expect(
      isUniqueViolation(new Error('UNIQUE constraint failed: requests.user_id, requests.asin')),
    ).toBe(true);
  });

  it('matches an error whose message mentions SQLITE_CONSTRAINT', () => {
    expect(isUniqueViolation(new Error('SQLITE_CONSTRAINT: ...'))).toBe(true);
  });

  it('does not match a plain non-constraint error', () => {
    expect(isUniqueViolation(new Error('boom'))).toBe(false);
  });

  it('stringifies and classifies a non-Error value without throwing', () => {
    expect(isUniqueViolation('UNIQUE constraint failed: x')).toBe(true);
    expect(isUniqueViolation('boom')).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
  });

  it('documents the broad SQLITE_CONSTRAINT arm (FK/CHECK/NOT-NULL also match today)', () => {
    // Known limitation: the regex is broader than SQLITE_CONSTRAINT_UNIQUE, so a FK or
    // CHECK breach also routes into the re-query path. Pinned so any future narrowing is
    // a deliberate, test-visible change.
    expect(isUniqueViolation(new Error('SQLITE_CONSTRAINT_FOREIGNKEY: FOREIGN KEY constraint failed'))).toBe(true);
  });
});
