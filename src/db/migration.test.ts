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
// post-rename increments (the user_caused_failure drop, notify_on, available_notified_at and
// its one-time backfill) are folded into the baseline. Pre-1.0 DBs are deliberately NOT
// auto-upgradable: the new baseline has a fresh journal timestamp so an old DB fails loudly at
// boot instead of silently skipping it. What matters here is that a fresh DB gets the complete
// final schema. The seed-then-migrate modality (seed-then-migrate.ts) stays for the next
// data-bearing migration; its worked example (the old 0003 backfill) left the tree with the squash.
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

  // issue #142: `users.kindle_email` is the FIRST append-only migration on top of the 1.0
  // baseline. Asserted against a fresh in-memory DB that applies the whole folder, so a
  // migration that never lands (an edited baseline — drizzle tracks by content hash, so it
  // would silently not re-run) fails here rather than at a customer's boot.
  it('applies the append-only 0001 kindle_email column on top of the baseline', async () => {
    const client = createClient({ url: ':memory:' });
    await migrate(drizzle(client), { migrationsFolder: drizzleDir });
    const info = (await client.execute("PRAGMA table_info('users')")).rows;
    const kindle = info.find((r) => r['name'] === 'kindle_email');
    expect(kindle).toBeDefined();
    expect(kindle?.['notnull']).toBe(0); // nullable — a pre-existing row needs no backfill
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

  // issue #144: the companion-ebook opt-in. Same fresh-DB shape check as 0001 above — a migration
  // that never lands (an edited baseline, which drizzle tracks by content hash and silently skips
  // on an existing DB) fails here rather than at a customer's boot.
  it('applies the append-only 0002 ebooks_enabled column on top of the baseline', async () => {
    const client = createClient({ url: ':memory:' });
    await migrate(drizzle(client), { migrationsFolder: drizzleDir });
    const col = (await client.execute("PRAGMA table_info('app_settings')")).rows.find(
      (r) => r['name'] === 'ebooks_enabled',
    );
    expect(col).toBeDefined();
    expect(col?.['notnull']).toBe(1); // NOT NULL — every read gets a concrete boolean
    client.close();
  });

  // AC2's other half, which a fresh-DB test CANNOT reach: an EXISTING install (schema stopped at
  // 0001, singleton row already written) must survive the in-place upgrade and read the new column
  // as false. Default OFF is the safe state — the flag is opt-in, never opt-out — so a migration
  // that defaulted it on, or that dropped/recreated the row, would silently publish ebooks to
  // every family member on upgrade.
  it('gives an EXISTING app_settings row ebooks_enabled = false when 0002 is applied in place', async () => {
    const client = await seedThenMigrate({
      target: '0002_app_settings_ebooks_enabled',
      seed: async (c) => {
        await c.execute(
          "INSERT INTO app_settings (id, default_quota_mode, default_quota_limit, default_quota_window_days) VALUES (1, 'limited', 7, 7)",
        );
      },
    });
    const rows = (await client.execute('SELECT id, default_quota_limit, ebooks_enabled FROM app_settings')).rows;
    expect(rows).toHaveLength(1);
    // The pre-existing row survives with its own values intact…
    expect(rows[0]?.['default_quota_limit']).toBe(7);
    // …and the new column reads falsy (SQLite stores the boolean default as 0).
    expect(rows[0]?.['ebooks_enabled']).toBe(0);
    client.close();
  });

  it('journal, .sql files and snapshots stay in lockstep — no stragglers, baseline untouched', () => {
    const journal = JSON.parse(
      fs.readFileSync(path.join(drizzleDir, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: { idx: number; tag: string }[] };
    // Migrations are APPEND-ONLY from the 1.0 baseline forward: 0000_baseline must remain the
    // first entry, with every later migration stacked after it in idx order.
    expect(journal.entries.map((e) => e.tag)).toEqual([
      '0000_baseline',
      '0001_user_kindle_email',
      '0002_app_settings_ebooks_enabled',
    ]);
    expect(journal.entries.map((e) => e.idx)).toEqual([0, 1, 2]);
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

  // The baseline is the from-scratch squash for 1.0 — later migrations stack ON it, never edit
  // it. This pins the one property that would silently break existing DBs if violated: the
  // baseline never carries a column that a later migration adds.
  it('leaves the 0000 baseline free of the columns later migrations add', () => {
    const baseline = fs.readFileSync(path.join(drizzleDir, '0000_baseline.sql'), 'utf8');
    expect(baseline).not.toContain('kindle_email');
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
