import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, type Client } from '@libsql/client';

const drizzleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');

interface JournalEntry {
  idx: number;
  tag: string;
}

/**
 * Migration tags in application order, read from drizzle's `_journal.json`.
 * `migrate()` applies the whole folder in one shot with no "up to N" option, so this
 * lets the test surface apply a chosen subset instead.
 */
function orderedTags(): string[] {
  const journal = JSON.parse(
    fs.readFileSync(path.join(drizzleDir, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: JournalEntry[] };
  return [...journal.entries].sort((a, b) => a.idx - b.idx).map((e) => e.tag);
}

/**
 * The individual SQL statements of a migration file, split on drizzle's
 * `--> statement-breakpoint` marker. Exposed so a test can grab the real statements of a
 * data-bearing migration and run a mutated variant (e.g. an inverted `WHERE`) to prove its
 * assertions are a genuine red — the released `.sql` is immutable, so the mutation lives in
 * the test, never on disk.
 */
export function migrationStatements(tag: string): string[] {
  const sql = fs.readFileSync(path.join(drizzleDir, `${tag}.sql`), 'utf8');
  return sql
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function applyStatements(client: Client, statements: string[]): Promise<void> {
  for (const stmt of statements) {
    await client.execute(stmt);
  }
}

/**
 * Seed-then-migrate test modality for data-bearing migrations.
 *
 * Builds a fresh in-memory libSQL schema by applying every migration **before** `target`,
 * lets the caller seed rows against that pre-migration schema, then applies `target` alone so
 * assertions can prove the migration's data transform touched the right rows only.
 *
 * @param opts.target     migration tag to isolate, e.g. `0003_add_available_notified_at`
 * @param opts.seed       callback to insert rows against the schema built up to (excluding) target
 * @param opts.statements override the statements applied for `target` (defaults to the real
 *                        file); use `migrationStatements(target)` + a mutation for red-test checks
 * @returns the open client — caller closes it
 */
export async function seedThenMigrate(opts: {
  target: string;
  seed: (client: Client) => Promise<void>;
  statements?: string[];
}): Promise<Client> {
  const tags = orderedTags();
  const idx = tags.indexOf(opts.target);
  if (idx < 0) throw new Error(`unknown migration tag: ${opts.target}`);

  const client = createClient({ url: ':memory:' });
  for (const tag of tags.slice(0, idx)) {
    await applyStatements(client, migrationStatements(tag));
  }
  await opts.seed(client);
  await applyStatements(client, opts.statements ?? migrationStatements(opts.target));
  return client;
}
