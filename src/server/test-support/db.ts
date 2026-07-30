import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { eq } from 'drizzle-orm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../../db/schema.js';
import { users } from '../../db/schema.js';
import type { Db } from '../../db/client.js';
import type { Role, UserStatus, RequestQuota } from '../../shared/schemas/user.js';
import { publicId } from '../util/ids.js';

const drizzleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../drizzle');

/** Fresh in-memory libSQL db with all migrations applied — one per test. */
export async function createTestDb(): Promise<Db> {
  const client = createClient({ url: ':memory:' });
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: drizzleDir });
  return db;
}

export async function insertUser(
  db: Db,
  opts: {
    role?: Role;
    status?: UserStatus;
    /** Per-user quota override as the explicit mode union. Omitted → `inherit` (app default). */
    requestQuota?: RequestQuota;
    username?: string;
    autoApprove?: boolean;
    provider?: string;
    subject?: string;
    passwordHash?: string | null;
    /** Stored CONTACT address (`users.email`) — the notification destination, not the login subject. */
    email?: string | null;
    /** Stored Send-to-Kindle device address (`users.kindle_email`, issue #142). Self-scoped PII;
     *  seeded directly here so the non-exposure tests can prove no admin surface serializes it. */
    kindleEmail?: string | null;
  } = {},
): Promise<{ id: number; publicId: string; role: Role; status: UserStatus; authSubject: string }> {
  const quota = opts.requestQuota ?? { mode: 'inherit' };
  const [row] = await db
    .insert(users)
    .values({
      publicId: publicId('us'),
      authProvider: opts.provider ?? 'plex',
      authSubject: opts.subject ?? publicId('sub'),
      username: opts.username ?? 'tester',
      passwordHash: opts.passwordHash ?? null,
      email: opts.email ?? null,
      kindleEmail: opts.kindleEmail ?? null,
      // Default to active so existing tests that create requesters keep working; the
      // approval queue is exercised explicitly where it matters.
      status: opts.status ?? 'active',
      role: opts.role ?? 'user',
      requestQuotaMode: quota.mode,
      requestQuotaLimit: quota.mode === 'limited' ? quota.limit : null,
      autoApprove: opts.autoApprove ?? false,
    })
    .returning();
  if (!row) throw new Error('failed to insert test user');
  return { id: row.id, publicId: row.publicId, role: row.role, status: row.status, authSubject: row.authSubject };
}

/**
 * A synthetic error shaped like a REAL drizzle/libSQL constraint rejection, so a classifier test
 * that cannot afford a real insert still sees the shape the classifier actually keys on.
 *
 * The chain is the real 3-level one (probed against `@libsql/client` 0.17.3):
 *
 *   L0 `DrizzleQueryError` — `Failed query: …\nparams: …`, NO `code`/`rawCode`
 *   L1 `LibsqlError`       — `SQLITE_CONSTRAINT: <driver message>`, generic `code`, `rawCode`
 *   L2 `SqliteError`       — `<driver message>`, EXTENDED `code`, the same `rawCode`
 *
 * `params` is the wrapper's echoed parameter line — the user-controlled text that made a
 * message-text classifier forgeable (issue #195). Hand-rolling this shape per call site is what
 * let the synthetic cases drift from the driver; build them all here.
 */
export function drizzleConstraintError(opts: {
  /** SQLite EXTENDED result code — 2067 UNIQUE, 787 FOREIGNKEY, 275 CHECK, 1299 NOTNULL. */
  rawCode: number;
  /** The extended code SPELLING on the inner sqlite error, e.g. `SQLITE_CONSTRAINT_UNIQUE`. */
  code: string;
  /** The driver's own message, e.g. `UNIQUE constraint failed: users.auth_provider, …`. */
  driverMessage: string;
  /** The wrapper's `params:` line. Defaults to a value that names no constraint. */
  params?: string;
  /** Table named in the wrapper's `Failed query:` line. */
  table?: string;
}): Error {
  const inner = Object.assign(new Error(opts.driverMessage), { code: opts.code, rawCode: opts.rawCode });
  const libsql = Object.assign(new Error(`SQLITE_CONSTRAINT: ${opts.driverMessage}`, { cause: inner }), {
    code: 'SQLITE_CONSTRAINT',
    rawCode: opts.rawCode,
  });
  return new Error(
    `Failed query: insert into "${opts.table ?? 'requests'}" (...) values (...) returning ...\n` +
      `params: ${opts.params ?? 'rq_x,1,B1,a title,pending'}`,
    { cause: libsql },
  );
}

/**
 * A REAL drizzle/libSQL rejection from a duplicate `users` insert — the shape
 * {@link drizzleConstraintError} claims to reproduce.
 *
 * Shared rather than inlined so the classifier tests and the factory's own contract test measure
 * against the SAME driver error: that is what makes a libSQL upgrade which renumbers `rawCode` or
 * renames a code spelling fail loudly instead of leaving a stale fixture certifying a shape
 * production no longer produces.
 */
export async function realDuplicateInsertError(): Promise<unknown> {
  const db = await createTestDb();
  await insertUser(db, { provider: 'local', subject: 'a@b.com' });
  try {
    await db
      .insert(users)
      .values({ publicId: publicId('us'), authProvider: 'local', authSubject: 'a@b.com', username: 'dupe' })
      .returning();
  } catch (err: unknown) {
    return err;
  }
  throw new Error('the duplicate insert did not reject');
}

/** Delete a user row by id — exercises the real session-lookup-miss boundary in tests. */
export async function deleteUser(db: Db, id: number): Promise<void> {
  await db.delete(users).where(eq(users.id, id));
}
