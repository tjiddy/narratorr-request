import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { seedThenMigrate, migrationStatements } from './seed-then-migrate.js';

const drizzleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');

// The migration history was squashed to a single 0000 for the 1.0 public release, so
// the legacy column-per-provider identity and its one-time backfill (the old 0003) no
// longer exist in the tree. What still matters is that applying the migration folder to
// a fresh DB yields the generic (auth_provider, auth_subject) identity schema.
describe('schema migrations', () => {
  it('applies cleanly on a fresh DB with the generic identity schema', async () => {
    const client = createClient({ url: ':memory:' });
    await migrate(drizzle(client), { migrationsFolder: drizzleDir });
    const cols = (await client.execute("PRAGMA table_info('users')")).rows.map((r) => r['name']);
    expect(cols).toEqual(
      expect.arrayContaining(['auth_provider', 'auth_subject', 'username', 'password_hash', 'status']),
    );
    expect(cols).not.toContain('plex_id');
    expect(cols).not.toContain('authelia_subject');
    client.close();
  });

  it('drops the never-producible user-fault failure column from requests', async () => {
    const client = createClient({ url: ':memory:' });
    await migrate(drizzle(client), { migrationsFolder: drizzleDir });
    const cols = (await client.execute("PRAGMA table_info('requests')")).rows.map((r) => r['name']);
    expect(cols).not.toContain('user_caused_failure');
    client.close();
  });
});

const TARGET_0003 = '0003_add_available_notified_at';

/**
 * Seed one `available` and one `acquiring` request (plus the user they FK to) against the
 * schema built up to 0002 — `available_notified_at` does not exist yet, so the 0003 backfill
 * has real rows to act on. `user_id` is NOT NULL and references `users(id)`, so the user is
 * inserted first to satisfy the FK.
 */
async function seedTwoRequests(client: Client): Promise<void> {
  await client.execute(
    "INSERT INTO users (id, public_id, auth_provider, auth_subject, username, status) " +
      "VALUES (1, 'us_seed', 'plex', 'sub_seed', 'seed', 'active')",
  );
  await client.execute(
    "INSERT INTO requests (public_id, user_id, asin, title, status) " +
      "VALUES ('rq_avail', 1, 'B00AVAIL', 'Settled Book', 'available')",
  );
  await client.execute(
    "INSERT INTO requests (public_id, user_id, asin, title, status) " +
      "VALUES ('rq_acq', 1, 'B00ACQ', 'In-Flight Book', 'acquiring')",
  );
}

async function markerFor(client: Client, publicId: string): Promise<number | null> {
  const row = (
    await client.execute({
      sql: 'SELECT available_notified_at FROM requests WHERE public_id = ?',
      args: [publicId],
    })
  ).rows[0];
  if (!row) throw new Error(`no request row for ${publicId}`);
  const value = row['available_notified_at'];
  return value === null ? null : Number(value);
}

// The 0003 backfill settles the `available_notified_at` marker for rows already `available` at
// upgrade time, so the poller sweep (which re-emails available rows with a null marker) does not
// re-notify them. These tests establish the seed-then-migrate modality and use 0003 as the first
// worked example: seed pre-migration rows, apply 0003 alone, assert the transform touched only the
// right rows. See src/db/seed-then-migrate.ts.
describe('0003 available_notified_at backfill', () => {
  it('marks a settled `available` row so the poller sweep skips it', async () => {
    const client = await seedThenMigrate({ target: TARGET_0003, seed: seedTwoRequests });
    try {
      expect(await markerFor(client, 'rq_avail')).not.toBeNull();
    } finally {
      client.close();
    }
  });

  it('leaves a non-`available` (acquiring) row untouched — still owed', async () => {
    const client = await seedThenMigrate({ target: TARGET_0003, seed: seedTwoRequests });
    try {
      expect(await markerFor(client, 'rq_acq')).toBeNull();
    } finally {
      client.close();
    }
  });

  it('backfills a plausible unix timestamp, not 0 or garbage', async () => {
    const client = await seedThenMigrate({ target: TARGET_0003, seed: seedTwoRequests });
    try {
      const marker = await markerFor(client, 'rq_avail');
      expect(marker).not.toBeNull();
      // unixepoch() is seconds; guard against a wrong marker expression (0, ms, or garbage).
      expect(marker).toBeGreaterThan(1_600_000_000); // after 2020-09
      expect(marker).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 5);
    } finally {
      client.close();
    }
  });

  // Red-test discipline: the released .sql is immutable, so this proves the assertions above have
  // teeth by running a harness-local variant of the 0003 statements with the backfill `WHERE`
  // clause inverted. Under the mutation the outcomes flip — confirming a wrong WHERE would be
  // caught, not silently pass against zero rows.
  it('mutation-sensitive: an inverted backfill WHERE flips which rows are marked', async () => {
    const statements = migrationStatements(TARGET_0003).map((stmt) =>
      stmt.includes('UPDATE') ? stmt.replace("= 'available'", "<> 'available'") : stmt,
    );
    // Sanity-check the mutation actually landed, so a future .sql reword can't neuter this test.
    expect(statements.some((s) => s.includes("<> 'available'"))).toBe(true);

    const client = await seedThenMigrate({ target: TARGET_0003, seed: seedTwoRequests, statements });
    try {
      // Inverted: the available row is now the one left untouched...
      expect(await markerFor(client, 'rq_avail')).toBeNull();
      // ...and the acquiring row is the one wrongly marked. Both differ from the correct backfill,
      // proving tests 1 and 2 would fail on this broken statement.
      expect(await markerFor(client, 'rq_acq')).not.toBeNull();
    } finally {
      client.close();
    }
  });
});

describe('seedThenMigrate helper', () => {
  it('rejects an unknown migration target before running the seed callback', async () => {
    let seeded = false;
    await expect(
      seedThenMigrate({
        target: '9999_does_not_exist',
        seed: async () => {
          seeded = true;
        },
      }),
    ).rejects.toThrow(/unknown migration tag/);
    // The guard must reject up front — never seed against a schema for a target it can't apply.
    expect(seeded).toBe(false);
  });
});
