import { sqliteTable, text, integer, index, uniqueIndex, check } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { USER_ROLES, USER_STATUSES, REQUEST_QUOTA_MODES, type Role, type NotifiableTransition } from '../shared/schemas/user.js';
import { REQUEST_STATUSES, ACTIVE_REQUEST_STATUSES } from '../shared/schemas/request.js';
import type { StoredConnectors } from '../shared/schemas/connectors.js';

// ============ USERS ============
// Identity is owned here, keyed on a generic (authProvider, authSubject) pair —
// pluggable across local auth and any OIDC provider. User uniqueness is the pair;
// there is NO account linking, so a user has exactly one identity (1:1). The
// dev-admin (AUTH_BYPASS) is a real row (provider 'local', subject 'dev-admin') so
// request creation always runs against a genuine user boundary, never a retrofit.
export const users = sqliteTable(
  'users',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    publicId: text('public_id').notNull().unique(), // us_...
    // Generic external identity. `authProvider` is the method ('local', 'plex',
    // 'authelia', or a configured OIDC provider id); `authSubject` is that
    // provider's stable subject (for local: the lowercased username). The pair is
    // unique — see the index below.
    authProvider: text('auth_provider').notNull(),
    authSubject: text('auth_subject').notNull(),
    // Display name (provider-agnostic). For local auth this is the original-case
    // username; for OIDC it's the mapped username claim.
    username: text('username').notNull(),
    // scrypt hash for local-auth users; null for OIDC identities (which never
    // authenticate via the password path).
    passwordHash: text('password_hash'),
    email: text('email'),
    // The user's own Send-to-Kindle device address (issue #142) — the destination an ebook is
    // delivered to, NEVER a contact/notification address. Self-scoped: written only via
    // `PATCH /api/me` and read only onto `MeDto`; no admin surface exposes or edits it.
    // Nullable and INDEPENDENT of `email` — deliberately NO CHECK coupling the two columns:
    // a predicate over two nullable columns hits the sqlite-check-null-is-satisfied trap (see
    // the request_quota check below), and the two addresses have genuinely unrelated lifecycles.
    kindleEmail: text('kindle_email'),
    thumb: text('thumb'),
    role: text('role', { enum: USER_ROLES }).notNull().default('user'),
    // Approval state (orthogonal to role). New users land 'pending'; an admin
    // approves (→ 'active') or rejects (→ 'rejected') in the Users page.
    status: text('status', { enum: USER_STATUSES }).notNull().default('pending'),
    // Per-user quota override as an explicit MODE (inherit/unlimited/limited/blocked) — no
    // overloaded `0`/`null`. `inherit` (the default) falls back to the app default; `limited`
    // carries a positive `request_quota_limit`; the other modes hold null (CHECK-enforced below).
    requestQuotaMode: text('request_quota_mode', { enum: REQUEST_QUOTA_MODES }).notNull().default('inherit'),
    requestQuotaLimit: integer('request_quota_limit'), // null unless mode = 'limited'
    // Per-user auto-approve: this user's requests skip the pending queue. Orthogonal
    // to quota — an auto-approved user's requests still count against their limit.
    autoApprove: integer('auto_approve', { mode: 'boolean' }).notNull().default(false),
    // Requester-notification opt-in (issue #50): the transitions this user asked to be
    // emailed about, as a JSON array keyed to `NOTIFIABLE_TRANSITIONS` (v1: ['available']).
    // Default empty (off); a corrupt/legacy value degrades to empty on read via
    // `sanitizeNotifyOn` — matching the autoApproveRoles/connectors JSON-on-a-row precedent.
    // NO opt-in↔contact DB CHECK: opt-in may legitimately outlive a contact, and a
    // JSON-array-vs-nullable-column CHECK hits the sqlite-check-null-is-satisfied trap (see
    // the request_quota check below); contact is gated at send time, not by a constraint.
    notifyOn: text('notify_on', { mode: 'json' })
      .notNull()
      .$type<NotifiableTransition[]>()
      .default(sql`'[]'`),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    uniqueIndex('idx_users_provider_subject').on(table.authProvider, table.authSubject),
    index('idx_users_username').on(table.username),
    // Mode↔limit coherence: a positive limit IFF the mode is 'limited', null otherwise. Makes a
    // half-set per-user override (limited with no limit, or a stray limit on inherit) unstorable.
    // Written so the predicate NEVER evaluates to NULL: SQLite treats a NULL CHECK as satisfied,
    // so the naive `(mode='limited' AND limit>0) OR …` leaks the limited-with-null-limit case
    // through. `(mode='limited') = (limit IS NOT NULL)` is a pure boolean both directions.
    check(
      'request_quota_mode_limit',
      sql`(${table.requestQuotaMode} = 'limited') = (${table.requestQuotaLimit} IS NOT NULL) AND (${table.requestQuotaLimit} IS NULL OR ${table.requestQuotaLimit} > 0)`,
    ),
  ],
);

// ============ REQUESTS ============
export const requests = sqliteTable(
  'requests',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    publicId: text('public_id').notNull().unique(), // rq_...
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    asin: text('asin').notNull(),
    // Snapshot of the catalog entry at request time — keeps the queue renderable
    // even if upstream metadata changes.
    title: text('title').notNull(),
    author: text('author'),
    narrator: text('narrator'),
    coverUrl: text('cover_url'),
    status: text('status', { enum: REQUEST_STATUSES }).notNull().default('pending'),
    // Handoff linkage into Narratorr: the library book we added + poll
    // (nullable until approved + handed off).
    narratorrBookId: text('narratorr_book_id'), // bk_...
    note: text('note'),
    failureReason: text('failure_reason'),
    requestedAt: integer('requested_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    decidedAt: integer('decided_at', { mode: 'timestamp' }),
    decidedBy: integer('decided_by').references(() => users.id, { onDelete: 'set null' }),
    // Durable "requester availability email settled" marker (issue #121). Nullable: null means the
    // availability email still owes an attempt; a timestamp means a TERMINAL per-row outcome was
    // reached (delivered, or a permanent no-op — not opted in / null email) and no further attempt
    // is needed. The poller sweep is the SOLE writer, setting it atomically
    // (`… WHERE available_notified_at IS NULL RETURNING`); a global no-config skip / transient SMTP
    // failure leaves it null so the row is re-attempted next tick.
    availableNotifiedAt: integer('available_notified_at', { mode: 'timestamp' }),
  },
  (table) => [
    index('idx_requests_user_id').on(table.userId),
    index('idx_requests_status').on(table.status),
    index('idx_requests_asin').on(table.asin),
    // Dedupe guard: at most ONE active request per (user, asin). We scope to the
    // user (not globally) because this is multi-user — two people may both want a
    // book; global dedupe is handled downstream by Narratorr's idempotent
    // ASIN-keyed acquisition. Deviates from PLAN's literal "unique(asin)" with
    // cause: a global guard would wrongly block a second requester. Re-requesting
    // after denied/failed/available is allowed (those aren't "active").
    uniqueIndex('idx_requests_user_asin_active')
      .on(table.userId, table.asin)
      .where(sql`status IN ('${sql.raw(ACTIVE_REQUEST_STATUSES.join("','"))}')`),
  ],
);

// ============ APP SETTINGS ============
// Singleton (id = 1). Seeded from config on first boot.
export const appSettings = sqliteTable(
  'app_settings',
  {
  id: integer('id').primaryKey(),
  // The app-wide default request quota as an explicit MODE (unlimited/limited) — no overloaded
  // `null`. `limited` carries a positive `default_quota_limit`; `unlimited` holds null
  // (CHECK-enforced below). Seeds `limited` / 10 on a fresh row (see SettingsService.ensure).
  defaultQuotaMode: text('default_quota_mode', { enum: ['unlimited', 'limited'] }).notNull().default('limited'),
  defaultQuotaLimit: integer('default_quota_limit'), // null unless mode = 'limited'
  // Rolling-window size (days) for the default quota — the friendly day/week/month unit
  // mapped to a fixed day count {1,7,30}. NOT NULL so the cutoff calc always has a concrete
  // value; default 30 seeds a fresh row and survives an omit-to-keep save. Rides BOTH modes.
  defaultQuotaWindowDays: integer('default_quota_window_days').notNull().default(30),
  // Which roles are auto-approved on request create. MVP: ['admin'].
  autoApproveRoles: text('auto_approve_roles', { mode: 'json' })
    .notNull()
    .$type<Role[]>()
    .default(sql`'["admin"]'`),
  // Legacy placeholder, never written — superseded by `connectors` below. Kept so the
  // migration diff stays a clean ADD COLUMN (dropping it makes drizzle-kit prompt).
  notifyConfig: text('notify_config', { mode: 'json' }).$type<Record<string, unknown>>(),
  // Connector config (narratorr connection + notification channels) edited on the
  // admin Settings page. Secret fields are stored ENCRYPTED (see SecretCodec). null
  // until the admin configures it in the UI (no env seeding).
  connectors: text('connectors', { mode: 'json' }).$type<StoredConnectors>(),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  },
  (table) => [
    // Mode↔limit coherence for the default quota: a positive limit IFF mode = 'limited'. Same
    // never-NULL form as the users CHECK (see there) so an incoherent row can't slip through.
    check(
      'default_quota_mode_limit',
      sql`(${table.defaultQuotaMode} = 'limited') = (${table.defaultQuotaLimit} IS NOT NULL) AND (${table.defaultQuotaLimit} IS NULL OR ${table.defaultQuotaLimit} > 0)`,
    ),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
export type RequestRow = typeof requests.$inferSelect;
export type NewRequestRow = typeof requests.$inferInsert;
export type AppSettingsRow = typeof appSettings.$inferSelect;
