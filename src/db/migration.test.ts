import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { seedThenMigrate } from './seed-then-migrate.js';

const drizzleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');

// The migration history was squashed (again) to a single 0000 for the 1.0 release — the
// companion-ebook increments (users.kindle_email, app_settings.ebooks_enabled, kindle_sends)
// are folded into the baseline alongside the earlier folds. Pre-squash DBs are deliberately
// NOT auto-upgradable: the new baseline has a fresh journal timestamp so an old DB fails
// loudly at boot instead of silently skipping it (upgrade = export users, fresh DB, re-import).
// What matters here is that a fresh DB gets the complete final schema. The seed-then-migrate
// modality (seed-then-migrate.ts) stays for the next data-bearing migration; its worked
// examples (the old 0002/0003 in-place upgrades) left the tree with the squash.
describe('schema migrations', () => {
  it('applies cleanly on a fresh DB with the generic identity schema', async () => {
    const client = createClient({ url: ':memory:' });
    await migrate(drizzle(client), { migrationsFolder: drizzleDir });
    const cols = (await client.execute("PRAGMA table_info('users')")).rows.map((r) => r['name']);
    expect(cols).toEqual(
      expect.arrayContaining(['auth_provider', 'auth_subject', 'username', 'password_hash', 'status', 'notify_on']),
    );
    expect(cols).not.toContain('plex_id');
    expect(cols).not.toContain('authelia_subject');
    client.close();
  });

  it('folds the post-baseline request columns into the baseline', async () => {
    const client = createClient({ url: ':memory:' });
    await migrate(drizzle(client), { migrationsFolder: drizzleDir });
    const cols = (await client.execute("PRAGMA table_info('requests')")).rows.map((r) => r['name']);
    expect(cols).toContain('available_notified_at');
    expect(cols).not.toContain('user_caused_failure');
    client.close();
  });

  // issue #142 (folded): `users.kindle_email` now ships in the baseline. Asserted against a
  // fresh in-memory DB applying the whole folder, so a squash that silently dropped the column
  // fails here rather than at a customer's boot.
  it('folds the kindle_email column into the baseline, nullable', async () => {
    const client = createClient({ url: ':memory:' });
    await migrate(drizzle(client), { migrationsFolder: drizzleDir });
    const info = (await client.execute("PRAGMA table_info('users')")).rows;
    const kindle = info.find((r) => r['name'] === 'kindle_email');
    expect(kindle).toBeDefined();
    expect(kindle?.['notnull']).toBe(0); // nullable — a fresh row needs no value
    client.close();
  });

  it('stores a users row with kindle_email both null and set', async () => {
    const client = createClient({ url: ':memory:' });
    await migrate(drizzle(client), { migrationsFolder: drizzleDir });
    await client.execute({
      sql: "INSERT INTO users (public_id, auth_provider, auth_subject, username) VALUES ('us_a','local','a@x.com','a')",
      args: [],
    });
    await client.execute({
      sql: "INSERT INTO users (public_id, auth_provider, auth_subject, username, kindle_email) VALUES ('us_b','local','b@x.com','b','b@kindle.com')",
      args: [],
    });
    const rows = (await client.execute('SELECT public_id, kindle_email FROM users ORDER BY public_id')).rows;
    expect(rows.map((r) => r['kindle_email'])).toEqual([null, 'b@kindle.com']);
    client.close();
  });

  // issue #144 (folded): the companion-ebook opt-in ships in the baseline. NOT NULL with a
  // false default — the flag is opt-in, never opt-out, so a squash that defaulted it on would
  // silently publish ebooks to every family member on a fresh install.
  it('folds ebooks_enabled into the baseline as NOT NULL defaulting to false', async () => {
    const client = createClient({ url: ':memory:' });
    await migrate(drizzle(client), { migrationsFolder: drizzleDir });
    const col = (await client.execute("PRAGMA table_info('app_settings')")).rows.find(
      (r) => r['name'] === 'ebooks_enabled',
    );
    expect(col).toBeDefined();
    expect(col?.['notnull']).toBe(1); // NOT NULL — every read gets a concrete boolean
    // The default is exercised, not just declared: a singleton row inserted without the column
    // (exactly what settings.ensure() does) must read back false.
    await client.execute(
      "INSERT INTO app_settings (id, default_quota_mode, default_quota_limit, default_quota_window_days) VALUES (1, 'limited', 7, 7)",
    );
    const rows = (await client.execute('SELECT ebooks_enabled FROM app_settings')).rows;
    expect(rows[0]?.['ebooks_enabled']).toBe(0);
    client.close();
  });

  it('journal, .sql files and snapshots stay in lockstep — a single squashed baseline', () => {
    const journal = JSON.parse(
      fs.readFileSync(path.join(drizzleDir, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: { idx: number; tag: string }[] };
    // Migrations are APPEND-ONLY from this baseline forward: 0000_baseline must remain the
    // first entry, with every later migration stacked after it in idx order. Today that means
    // exactly one entry; a new feature migration extends this expectation, never rewrites it.
    expect(journal.entries.map((e) => e.tag)).toEqual(['0000_baseline']);
    expect(journal.entries.map((e) => e.idx)).toEqual([0]);
    // The .sql files and meta snapshots must match the journal — a stale leftover would
    // change what migrate() applies (sql) or what drizzle-kit diffs against (snapshot).
    const sqlFiles = fs.readdirSync(drizzleDir).filter((f) => f.endsWith('.sql')).sort();
    expect(sqlFiles).toEqual(journal.entries.map((e) => `${e.tag}.sql`));
    const snapshots = fs
      .readdirSync(path.join(drizzleDir, 'meta'))
      .filter((f) => f.endsWith('_snapshot.json'))
      .sort();
    expect(snapshots).toEqual(journal.entries.map((e) => `${String(e.idx).padStart(4, '0')}_snapshot.json`));
  });

  // The squash-completeness check: everything the folded migrations added must be IN the
  // baseline text, because there is no later migration left to supply it. A regeneration from
  // a stale schema.ts would pass the journal test and fail here.
  it('carries every folded feature in the 0000 baseline', () => {
    const baseline = fs.readFileSync(path.join(drizzleDir, '0000_baseline.sql'), 'utf8');
    expect(baseline).toContain('kindle_email');
    expect(baseline).toContain('ebooks_enabled');
    expect(baseline).toContain('kindle_sends');
  });
});

// issue #148 — the `kindle_sends` audit table IS the Send-to-Kindle admission mechanism, so the
// two constraints that carry the durable guarantees (the partial unique index and the coherence
// CHECK) are asserted against a REAL in-memory libSQL DB applying the generated SQL. Drizzle
// renders the JS `check()` verbatim, and SQLite treats a NULL-evaluating CHECK as SATISFIED, so a
// naively-written predicate would silently pass every incoherent row.
describe('kindle_sends schema (issue #148)', () => {
  /** A fresh migrated DB with one user (id 1) to hang audit rows off. */
  async function seededDb() {
    const client = createClient({ url: ':memory:' });
    await migrate(drizzle(client), { migrationsFolder: drizzleDir });
    await client.execute(
      "INSERT INTO users (public_id, auth_provider, auth_subject, username) VALUES ('us_a','local','a','a')",
    );
    return client;
  }

  const insert = (
    client: Awaited<ReturnType<typeof seededDb>>,
    row: { userId?: number; bookId: string; status: string; finalizedAt?: number | null },
  ) =>
    client.execute({
      sql: 'INSERT INTO kindle_sends (user_id, book_id, status, started_at, finalized_at) VALUES (?, ?, ?, 1000, ?)',
      args: [row.userId ?? 1, row.bookId, row.status, row.finalizedAt ?? null],
    });

  it('creates the kindle_sends table from the baseline with the exact column set', async () => {
    const client = await seededDb();
    const cols = (await client.execute("PRAGMA table_info('kindle_sends')")).rows.map((r) => r['name']);
    expect(cols).toEqual([
      'id',
      'user_id',
      'book_id',
      'status',
      'byte_count',
      'failure_code',
      'started_at',
      'finalized_at',
    ]);
    // `byte_count` is nullable on purpose — unknown until the stream establishes it.
    const byteCount = (await client.execute("PRAGMA table_info('kindle_sends')")).rows.find(
      (r) => r['name'] === 'byte_count',
    );
    expect(byteCount?.['notnull']).toBe(0);
    client.close();
  });

  it('declares every index the spec names, and no bare started_at index', async () => {
    const client = await seededDb();
    const rows = (await client.execute("PRAGMA index_list('kindle_sends')")).rows;
    const names = rows.map((r) => String(r['name'])).sort();
    expect(names).toEqual([
      'idx_kindle_sends_active',
      'idx_kindle_sends_finalized',
      'idx_kindle_sends_replay',
      'idx_kindle_sends_user_finalized',
      'idx_kindle_sends_user_started',
    ]);
    // Only the active-reservation guard is unique, and it is PARTIAL — a non-partial unique index
    // would block re-sending a book forever.
    const active = rows.find((r) => r['name'] === 'idx_kindle_sends_active');
    expect(active?.['unique']).toBe(1);
    expect(active?.['partial']).toBe(1);
    client.close();
  });

  it('rejects a second STARTED row for the same (user, book) and permits one once the first is finalized', async () => {
    const client = await seededDb();
    await insert(client, { bookId: 'bk_1', status: 'started' });
    await expect(insert(client, { bookId: 'bk_1', status: 'started' })).rejects.toThrow(
      /UNIQUE constraint failed/i,
    );
    // A different book for the same user is unaffected — the guard is per (user, book).
    await insert(client, { bookId: 'bk_2', status: 'started' });
    // …and so is the same book for a different user.
    await client.execute(
      "INSERT INTO users (public_id, auth_provider, auth_subject, username) VALUES ('us_b','local','b','b')",
    );
    await insert(client, { userId: 2, bookId: 'bk_1', status: 'started' });

    // Finalizing the first frees the slot: the partial index covers `started` rows only.
    await client.execute("UPDATE kindle_sends SET status='sent', finalized_at=2000 WHERE book_id='bk_1' AND user_id=1");
    await insert(client, { bookId: 'bk_1', status: 'started' });
    const n = (await client.execute("SELECT count(*) AS n FROM kindle_sends WHERE user_id=1 AND book_id='bk_1'")).rows;
    expect(n[0]?.['n']).toBe(2);
    client.close();
  });

  it('rejects EVERY incoherent status/finalized_at corner (the never-NULL CHECK form)', async () => {
    const client = await seededDb();
    // `started` with a finalized_at — the case a NULL-evaluating predicate would let through.
    await expect(insert(client, { bookId: 'bk_a', status: 'started', finalizedAt: 5 })).rejects.toThrow(
      /CHECK constraint failed/i,
    );
    // …and each terminal status with a NULL finalized_at.
    for (const status of ['sent', 'failed', 'indeterminate']) {
      await expect(insert(client, { bookId: `bk_${status}`, status, finalizedAt: null })).rejects.toThrow(
        /CHECK constraint failed/i,
      );
    }
    // The two coherent shapes store fine.
    await insert(client, { bookId: 'bk_ok1', status: 'started', finalizedAt: null });
    await insert(client, { bookId: 'bk_ok2', status: 'sent', finalizedAt: 9 });
    expect((await client.execute('SELECT count(*) AS n FROM kindle_sends')).rows[0]?.['n']).toBe(2);
    client.close();
  });

  it('cascades audit rows away when the user row is deleted', async () => {
    const client = await seededDb();
    await insert(client, { bookId: 'bk_1', status: 'sent', finalizedAt: 2000 });
    await insert(client, { bookId: 'bk_2', status: 'started' });
    await client.execute('DELETE FROM users WHERE id = 1');
    // Exercised at the DB level: the app has no user-delete path, so nothing else would catch a
    // missing ON DELETE CASCADE until an orphan row broke a later foreign-key check.
    expect((await client.execute('SELECT count(*) AS n FROM kindle_sends')).rows[0]?.['n']).toBe(0);
    client.close();
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
