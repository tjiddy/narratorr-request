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

/** Delete a user row by id — exercises the real session-lookup-miss boundary in tests. */
export async function deleteUser(db: Db, id: number): Promise<void> {
  await db.delete(users).where(eq(users.id, id));
}
