import { and, asc, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { users, type UserRow } from '../../db/schema.js';
import type { Role, UserStatus, UserDto, UpdateUserBody, NotifiableTransition } from '../../shared/schemas/user.js';
import type { AuthUser } from '../types.js';
import type { OidcProfile } from './oidc.service.js';
import { publicId } from '../util/ids.js';
import { notFound } from '../util/errors.js';
import { isUniqueViolation } from '../util/db.js';

export const DEV_ADMIN_PROVIDER = 'local';
export const DEV_ADMIN_SUBJECT = 'dev-admin';

/** Identity fields written when creating a user (local or OIDC). */
interface NewIdentity {
  authProvider: string;
  authSubject: string;
  username: string;
  email?: string | null;
  thumb?: string | null;
  passwordHash?: string | null;
}

/** Pins admin to a single identity; disables first-user-auto-admin when set. */
export interface BootstrapAdmin {
  provider: string;
  /** Matches an identity's authSubject (exact) or username (case-insensitive). */
  value: string;
}

/**
 * Result of a login/signup upsert. `created` is true only when THIS call inserted a
 * brand-new identity — the auth routes use it to fire the `user.pending` notification
 * exactly once (a returning user re-logging in must not re-notify). Mirrors
 * RequestService.create's `{ row, created }`.
 */
export interface UpsertResult {
  user: UserRow;
  created: boolean;
}

export class UserService {
  constructor(
    private readonly db: Db,
    private readonly opts: { bootstrapAdmin?: BootstrapAdmin | null } = {},
  ) {}

  toAuthUser(row: UserRow): AuthUser {
    return {
      id: row.id,
      publicId: row.publicId,
      username: row.username,
      role: row.role,
      status: row.status,
    };
  }

  /**
   * The ADMIN user mapper — an explicit allow-list, never a spread of the row. Every admin surface
   * (`GET /api/admin/users`, `PATCH /api/admin/users/:publicId`) serializes through it, so a column
   * absent here can never reach an admin. `passwordHash` is the credential-leak guard; `kindleEmail`
   * (#142) and `notifyOn` are SELF-SCOPED — they belong to `MeDto` (built in `routes/auth.ts`) only.
   * Do NOT add them here: `userDtoSchema` is a non-strict `z.object`, so the route serializer would
   * silently strip an added key and mask the leak from a response-body assertion.
   */
  toDto(row: UserRow): UserDto {
    return {
      publicId: row.publicId,
      username: row.username,
      authProvider: row.authProvider,
      email: row.email,
      thumb: row.thumb,
      role: row.role,
      status: row.status,
      requestQuota: this.requestQuotaDto(row),
      autoApprove: row.autoApprove,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** Serialize the two per-user quota columns into the four-mode union. `limited` carries the
   *  positive limit (CHECK-guaranteed); every other mode is a bare `{ mode }`. */
  private requestQuotaDto(row: Pick<UserRow, 'requestQuotaMode' | 'requestQuotaLimit'>): UserDto['requestQuota'] {
    if (row.requestQuotaMode === 'limited' && row.requestQuotaLimit !== null) {
      return { mode: 'limited', limit: row.requestQuotaLimit };
    }
    return { mode: row.requestQuotaMode === 'limited' ? 'inherit' : row.requestQuotaMode };
  }

  async getById(id: number): Promise<UserRow | undefined> {
    return this.db.query.users.findFirst({ where: eq(users.id, id) });
  }

  async getByPublicId(pid: string): Promise<UserRow | undefined> {
    return this.db.query.users.findFirst({ where: eq(users.publicId, pid) });
  }

  /** All users, oldest first — for the admin Users page. */
  async listAll(): Promise<UserRow[]> {
    return this.db.query.users.findMany({ orderBy: asc(users.createdAt) });
  }

  private async findByIdentity(provider: string, subject: string): Promise<UserRow | undefined> {
    return this.db.query.users.findFirst({
      where: and(eq(users.authProvider, provider), eq(users.authSubject, subject)),
    });
  }

  /** Look up a local-auth user by email (the lowercased email is the local subject key). */
  async findLocalByEmail(email: string): Promise<UserRow | undefined> {
    return this.findByIdentity('local', email.trim().toLowerCase());
  }

  /** Partial-update a user (admin Users page): role, approval status, per-user quota
   *  override, and/or the auto-approve flag. The "can't change your own role/status"
   *  guard lives in the route, where the acting admin's identity is known. */
  async updateUser(pid: string, patch: UpdateUserBody): Promise<UserRow> {
    const set: Partial<Pick<UserRow, 'role' | 'status' | 'requestQuotaMode' | 'requestQuotaLimit' | 'autoApprove'>> = {};
    if (patch.role !== undefined) set.role = patch.role;
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.requestQuota !== undefined) {
      // Mode → columns: a `limited` override sets the positive limit; every other mode nulls it,
      // keeping the row CHECK-coherent.
      set.requestQuotaMode = patch.requestQuota.mode;
      set.requestQuotaLimit = patch.requestQuota.mode === 'limited' ? patch.requestQuota.limit : null;
    }
    if (patch.autoApprove !== undefined) set.autoApprove = patch.autoApprove;
    if (Object.keys(set).length === 0) {
      const existing = await this.getByPublicId(pid);
      if (!existing) throw notFound('user not found');
      return existing;
    }
    const [updated] = await this.db.update(users).set(set).where(eq(users.publicId, pid)).returning();
    if (!updated) throw notFound('user not found');
    return updated;
  }

  /**
   * Set the caller's own requester-notification opt-in set (issue #50). Self-scoped: the route
   * passes the AUTHENTICATED user's id, and this touches only `notify_on` — no path here can
   * mutate another user or any other column. Storage-permissive by design (Design #4): the set is
   * persisted regardless of email/SMTP state (opt-in may legitimately outlive a contact); delivery
   * is gated at send time, not here. `notifyOn` is already validated to `NotifiableTransition[]`
   * by the route's Zod body, so it's stored as-is. Returns the updated row.
   */
  async setNotifyOn(userId: number, notifyOn: NotifiableTransition[]): Promise<UserRow> {
    const [updated] = await this.db
      .update(users)
      .set({ notifyOn })
      .where(eq(users.id, userId))
      .returning();
    if (!updated) throw notFound('user not found');
    return updated;
  }

  /**
   * Set or clear the caller's own CONTACT email (issue #131) — the address requester
   * notifications are delivered to (`users.email`), NEVER the login identity (`authSubject`). Self-
   * scoped: the route passes the AUTHENTICATED user's id and this touches only `email`, so no path
   * here can mutate another user, the login subject, or any other column. `email` is already
   * normalized (trim + lowercase) and deliverability-validated by the route's `contactEmailSchema`
   * body, or `null` to clear (which re-enables OIDC provider backfill on the next login — see
   * {@link upsertFromOidc}). Returns the updated row.
   */
  async setContactEmail(userId: number, email: string | null): Promise<UserRow> {
    const [updated] = await this.db
      .update(users)
      .set({ email })
      .where(eq(users.id, userId))
      .returning();
    if (!updated) throw notFound('user not found');
    return updated;
  }

  /**
   * Set or clear the caller's own SEND-TO-KINDLE device address (issue #142) — the destination an
   * ebook is delivered to (`users.kindle_email`), never a contact/notification address and never the
   * login identity. Self-scoped and INDEPENDENT of {@link setContactEmail}: the route passes the
   * AUTHENTICATED user's id and this touches only `kindle_email`, so no path here can mutate another
   * user or clobber a sibling column (in particular `email`, which alone drives
   * `hasDeliverableContact` / `emailNotifyAvailable` — a Kindle address never makes requester email
   * notifications available). `kindleEmail` is already normalized (trim + lowercase) and
   * domain-validated by the route's `kindleEmailSchema` body, or `null` to clear. A single atomic
   * UPDATE — no `db.transaction()` (libSQL `:memory:` breaks across transactions in tests). Returns
   * the updated row.
   */
  async setKindleEmail(userId: number, kindleEmail: string | null): Promise<UserRow> {
    const [updated] = await this.db
      .update(users)
      .set({ kindleEmail })
      .where(eq(users.id, userId))
      .returning();
    if (!updated) throw notFound('user not found');
    return updated;
  }

  /**
   * Upsert a user from an OIDC profile, keyed on (provider, subject). A returning user
   * refreshes their display fields — but only while `pending`/`active`; a `rejected`
   * account's metadata is frozen so a denied user can't keep churning their profile.
   * Role/status are never downgraded here. A new identity goes through the approval
   * queue (see `createIdentity`).
   */
  async upsertFromOidc(provider: string, profile: OidcProfile): Promise<UpsertResult> {
    const existing = await this.findByIdentity(provider, profile.subject);
    if (existing) {
      if (existing.status === 'rejected') return { user: existing, created: false };
      // Contact email is BACKFILL-ONLY (issue #131): a stored address — whether manually set on the
      // account page or previously derived from a claim — WINS over the incoming provider claim, so a
      // re-login never clobbers a manual edit. The claim fills it only when the row has none (first
      // login, or after the user cleared it via `email: null`, which re-enables backfill). This is the
      // single authoritative precedence: manual contact email wins until cleared. `authSubject` (login
      // identity) is untouched either way. Thumb still refreshes from the claim (display-only, no manual
      // edit surface); a later login that OMITS the thumb claim still can't blank a value we have.
      const [updated] = await this.db
        .update(users)
        .set({
          username: profile.username,
          email: existing.email ?? profile.email,
          thumb: profile.thumb ?? existing.thumb,
        })
        .where(eq(users.id, existing.id))
        .returning();
      return { user: updated ?? existing, created: false };
    }
    return this.createIdentity({
      authProvider: provider,
      authSubject: profile.subject,
      username: profile.username,
      email: profile.email,
      thumb: profile.thumb,
    });
  }

  /** Create a local-auth user. The (lowercased) email is the stable subject key and the
   *  stored contact; the display `username` is the email's local-part. Approval queue applies. */
  async createLocalUser(input: { email: string; passwordHash: string }): Promise<UpsertResult> {
    const email = input.email.trim().toLowerCase();
    return this.createIdentity({
      authProvider: 'local',
      authSubject: email,
      username: email.split('@')[0] || email,
      email,
      passwordHash: input.passwordHash,
    });
  }

  /**
   * Create a new identity, deciding its role + approval status. When BOOTSTRAP_ADMIN is
   * configured the grant is decided in JS (deterministic identity match). Otherwise the
   * first-user-admin decision is folded into the INSERT as a `CASE` on `count(*)`, so it
   * is evaluated atomically under SQLite's single-writer lock — two concurrent first-ever
   * signups can't both become admin (no read-modify-write race). Falls back to
   * read-on-conflict if the unique (provider, subject) index fires from a concurrent
   * identical login.
   */
  private async createIdentity(identity: NewIdentity): Promise<UpsertResult> {
    const literal = this.bootstrapGrant(identity);
    // First-user-admin as an atomic subquery (only when no bootstrap pin is set). The
    // count EXCLUDES the AUTH_BYPASS dev-admin sentinel so that flipping a smoke install
    // (AUTH_BYPASS=1) to real auth on the same volume still lets the first real user become
    // admin — otherwise the persisted dev-admin row would occupy the slot and brick login.
    const realUserCount = sql`(SELECT count(*) FROM ${users} WHERE NOT (${users.authProvider} = ${DEV_ADMIN_PROVIDER} AND ${users.authSubject} = ${DEV_ADMIN_SUBJECT}))`;
    const role = literal
      ? literal.role
      : sql<Role>`(CASE WHEN ${realUserCount} = 0 THEN 'admin' ELSE 'user' END)`;
    const status = literal
      ? literal.status
      : sql<UserStatus>`(CASE WHEN ${realUserCount} = 0 THEN 'active' ELSE 'pending' END)`;
    try {
      const [created] = await this.db
        .insert(users)
        .values({
          publicId: publicId('us'),
          authProvider: identity.authProvider,
          authSubject: identity.authSubject,
          username: identity.username,
          passwordHash: identity.passwordHash ?? null,
          email: identity.email ?? null,
          thumb: identity.thumb ?? null,
          role,
          status,
        })
        .returning();
      if (!created) throw new Error('failed to create user');
      return { user: created, created: true };
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        // Lost a race to a concurrent identical login — the row already exists and we
        // did NOT create it, so the caller must not treat this as a new signup.
        const existing = await this.findByIdentity(identity.authProvider, identity.authSubject);
        if (existing) return { user: existing, created: false };
      }
      throw err;
    }
  }

  /**
   * With `BOOTSTRAP_ADMIN` configured, ONLY the pinned identity is admin+active and
   * everyone else is pending — first-user-auto-admin is OFF (closes "first public OIDC
   * login owns the app" for open IdPs). Returns null when no pin is set, in which case
   * the caller applies the count-based first-user rule.
   */
  private bootstrapGrant(identity: NewIdentity): { role: Role; status: UserStatus } | null {
    const bootstrap = this.opts.bootstrapAdmin;
    if (!bootstrap) return null;
    // Match on the stable subject OR (conveniently) the display username. NOTE: on an
    // OPEN IdP the username claim is user-controllable, so the username arm trusts the
    // provider — docs recommend pinning by `subject` for public/open providers.
    const matches =
      bootstrap.provider === identity.authProvider &&
      (bootstrap.value === identity.authSubject ||
        bootstrap.value.toLowerCase() === identity.username.toLowerCase());
    return matches ? { role: 'admin', status: 'active' } : { role: 'user', status: 'pending' };
  }

  /** Idempotently ensure the AUTH_BYPASS dev admin exists; returns it. */
  async ensureDevAdmin(): Promise<UserRow> {
    const existing = await this.findByIdentity(DEV_ADMIN_PROVIDER, DEV_ADMIN_SUBJECT);
    if (existing) return existing;
    const [created] = await this.db
      .insert(users)
      .values({
        publicId: publicId('us'),
        authProvider: DEV_ADMIN_PROVIDER,
        authSubject: DEV_ADMIN_SUBJECT,
        username: 'dev-admin',
        role: 'admin',
        status: 'active',
      })
      .onConflictDoNothing()
      .returning();
    if (created) return created;
    // Lost a race — read it back.
    const row = await this.findByIdentity(DEV_ADMIN_PROVIDER, DEV_ADMIN_SUBJECT);
    if (!row) throw new Error('failed to ensure dev admin');
    return row;
  }
}
