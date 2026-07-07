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

  it('has exactly one journal entry — the squash left no stragglers', () => {
    const journal = JSON.parse(
      fs.readFileSync(path.join(drizzleDir, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: { tag: string }[] };
    expect(journal.entries.map((e) => e.tag)).toEqual(['0000_baseline']);
    // The .sql files and meta snapshots must match the journal — a stale leftover would
    // change what migrate() applies (sql) or what drizzle-kit diffs against (snapshot).
    const sqlFiles = fs.readdirSync(drizzleDir).filter((f) => f.endsWith('.sql'));
    expect(sqlFiles).toEqual(['0000_baseline.sql']);
    const snapshots = fs.readdirSync(path.join(drizzleDir, 'meta')).filter((f) => f.endsWith('_snapshot.json'));
    expect(snapshots).toEqual(['0000_snapshot.json']);
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
