import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { UserService } from './user.service.js';
import { makeOidcMapper, type OidcProfile } from './oidc.service.js';
import { createTestDb, insertUser } from '../test-support/db.js';
import type { Db } from '../../db/client.js';

let db: Db;
let svc: UserService;

const prof = (subject: string, username: string, email: string | null = null): OidcProfile => ({
  subject,
  username,
  email,
  thumb: null,
});

beforeEach(async () => {
  db = await createTestDb();
  svc = new UserService(db);
});

describe('UserService role/status management', () => {
  it('lists users oldest-first and flips a role', async () => {
    const alice = await insertUser(db, { role: 'user', username: 'alice' });
    await insertUser(db, { role: 'admin', username: 'bob' });

    const all = await svc.listAll();
    expect(all.map((u) => u.username)).toEqual(['alice', 'bob']);

    const promoted = await svc.updateUser(alice.publicId, { role: 'admin' });
    expect(promoted.role).toBe('admin');
    const demoted = await svc.updateUser(alice.publicId, { role: 'user' });
    expect(demoted.role).toBe('user');
  });

  it('approves and rejects via the status patch', async () => {
    const u = await insertUser(db, { role: 'user', status: 'pending' });
    expect((await svc.updateUser(u.publicId, { status: 'active' })).status).toBe('active');
    expect((await svc.updateUser(u.publicId, { status: 'rejected' })).status).toBe('rejected');
  });

  it('updates quota mode/limit + auto-approve independently, leaving untouched fields alone', async () => {
    const u = await insertUser(db, { role: 'user' });
    const set = await svc.updateUser(u.publicId, { requestQuota: { mode: 'limited', limit: 3 }, autoApprove: true });
    expect(set.requestQuotaMode).toBe('limited');
    expect(set.requestQuotaLimit).toBe(3);
    expect(set.autoApprove).toBe(true);

    // Switching to a non-limited mode nulls the limit column (CHECK-coherent).
    const blocked = await svc.updateUser(u.publicId, { requestQuota: { mode: 'blocked' } });
    expect(blocked.requestQuotaMode).toBe('blocked');
    expect(blocked.requestQuotaLimit).toBeNull();

    const cleared = await svc.updateUser(u.publicId, { requestQuota: { mode: 'inherit' } });
    expect(cleared.requestQuotaMode).toBe('inherit');
    expect(cleared.requestQuotaLimit).toBeNull();
    expect(cleared.autoApprove).toBe(true); // untouched by the quota-only patch
  });

  it('serializes the persisted columns into the four-mode union DTO', async () => {
    const u = await insertUser(db, { role: 'user', requestQuota: { mode: 'limited', limit: 5 } });
    const row = await svc.getByPublicId(u.publicId);
    expect(svc.toDto(row!).requestQuota).toEqual({ mode: 'limited', limit: 5 });
    const inheritUser = await insertUser(db, { role: 'user' });
    const inheritRow = await svc.getByPublicId(inheritUser.publicId);
    expect(svc.toDto(inheritRow!).requestQuota).toEqual({ mode: 'inherit' });
  });

  it('throws 404 for an unknown user', async () => {
    await expect(svc.updateUser('us_nope', { role: 'admin' })).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('UserService OIDC upsert + approval queue', () => {
  it('first user (any method) becomes admin + active; everyone after lands pending', async () => {
    const first = await svc.upsertFromOidc('plex', prof('p1', 'todd'));
    expect(first.created).toBe(true);
    expect(first.user).toMatchObject({ role: 'admin', status: 'active', authProvider: 'plex', authSubject: 'p1' });

    const second = await svc.upsertFromOidc('plex', prof('p2', 'bob'));
    expect(second.created).toBe(true);
    expect(second.user).toMatchObject({ role: 'user', status: 'pending' });
  });

  it('upserts are keyed on (provider, subject) — same subject across providers = two accounts', async () => {
    const a = await svc.upsertFromOidc('plex', prof('shared', 'a'));
    const b = await svc.upsertFromOidc('authelia', prof('shared', 'b'));
    expect(a.user.id).not.toBe(b.user.id);
    expect((await svc.listAll()).length).toBe(2);
  });

  it('refreshes display fields for a returning active user but PRESERVES the stored contact email (#131 backfill-only)', async () => {
    const created = await svc.upsertFromOidc('plex', prof('p1', 'old-name', 'old@x.com'));
    expect(created.created).toBe(true);
    const again = await svc.upsertFromOidc('plex', prof('p1', 'new-name', 'new@x.com'));
    expect(again.created).toBe(false); // returning login — not a new signup, no notification
    expect(again.user.id).toBe(created.user.id);
    // username refreshes; the contact email is BACKFILL-ONLY, so a differing claim does NOT overwrite it.
    expect(again.user).toMatchObject({ username: 'new-name', email: 'old@x.com' });
  });

  describe('contact-email precedence: manual wins until cleared (#131)', () => {
    it('backfills the contact from the claim when the row has none', async () => {
      const created = await svc.upsertFromOidc('plex', prof('p1', 'todd', null)); // first login, no email claim
      expect(created.user.email).toBeNull();
      const reauth = await svc.upsertFromOidc('plex', prof('p1', 'todd', 'claim@x.com')); // later login carries one
      expect(reauth.user.email).toBe('claim@x.com'); // row had none → backfilled
    });

    it('a stored contact wins over a differing later claim (manual edit survives re-login)', async () => {
      const created = await svc.upsertFromOidc('plex', prof('p1', 'todd', null));
      await svc.setContactEmail(created.user.id, 'manual@x.com'); // user edits the account email
      const reauth = await svc.upsertFromOidc('plex', prof('p1', 'todd', 'claim@x.com'));
      expect(reauth.user.email).toBe('manual@x.com'); // stored wins, claim ignored
    });

    it('clearing the contact (null) re-enables provider backfill on the next login', async () => {
      const created = await svc.upsertFromOidc('plex', prof('p1', 'todd', 'first@x.com'));
      await svc.setContactEmail(created.user.id, null); // user clears it
      const reauth = await svc.upsertFromOidc('plex', prof('p1', 'todd', 'claim@x.com'));
      expect(reauth.user.email).toBe('claim@x.com'); // row now has none → backfilled again
    });
  });

  describe('setContactEmail — self-scoped contact write (#131)', () => {
    it('sets and clears the contact email without touching the login authSubject', async () => {
      const created = await svc.upsertFromOidc('plex', prof('p1', 'todd', null));
      const subject = created.user.authSubject;

      const set = await svc.setContactEmail(created.user.id, 'contact@x.com');
      expect(set.email).toBe('contact@x.com');
      expect(set.authSubject).toBe(subject); // login identity untouched

      const cleared = await svc.setContactEmail(created.user.id, null);
      expect(cleared.email).toBeNull();
      expect(cleared.authSubject).toBe(subject);
    });

    it('throws not-found for an unknown user id', async () => {
      await expect(svc.setContactEmail(9999, 'x@x.com')).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('setKindleEmail — self-scoped Kindle-address write (#142)', () => {
    it('sets then clears the Kindle address, touching no other column on the row', async () => {
      const seeded = await insertUser(db, { role: 'admin', status: 'active', email: 'contact@x.com' });
      await svc.setNotifyOn(seeded.id, ['approved']);
      const before = await svc.getById(seeded.id);
      expect(before?.kindleEmail).toBeNull(); // a user who never set one reads null

      const set = await svc.setKindleEmail(seeded.id, 'device@kindle.com');
      expect(set.kindleEmail).toBe('device@kindle.com');
      // The sibling columns a shared write path could clobber.
      expect(set).toMatchObject({
        email: 'contact@x.com',
        notifyOn: ['approved'],
        role: 'admin',
        status: 'active',
        requestQuotaMode: before?.requestQuotaMode,
        authSubject: seeded.authSubject,
      });

      const cleared = await svc.setKindleEmail(seeded.id, null);
      expect(cleared.kindleEmail).toBeNull();
      expect(cleared).toMatchObject({ email: 'contact@x.com', notifyOn: ['approved'], role: 'admin', status: 'active' });
    });

    it('mutates only the target row — a second user is unaffected', async () => {
      const alice = await insertUser(db, { username: 'alice' });
      const bob = await insertUser(db, { username: 'bob' });

      await svc.setKindleEmail(bob.id, 'bob@kindle.com');

      expect((await svc.getById(alice.id))?.kindleEmail).toBeNull();
      expect((await svc.getById(bob.id))?.kindleEmail).toBe('bob@kindle.com');
    });

    it('throws not-found for an unknown user id', async () => {
      await expect(svc.setKindleEmail(9999, 'x@kindle.com')).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  // issue #120: an OIDC email claim now passes through the deliverability gate in the mapper
  // before reaching upsert. These pin the mapper→upsert chain: a garbage/over-length claim maps
  // to null, and null routes through the existing coalesce exactly like an absent claim.
  describe('email deliverability at OIDC storage (issue #120)', () => {
    const map = makeOidcMapper('Test');

    it('a returning identity whose IdP now emits a malformed claim keeps its last-known-good email', async () => {
      const created = await svc.upsertFromOidc('plex', prof('p1', 'todd', 'good@x.com'));
      // A later login where the IdP emits garbage → mapper yields email: null → coalesce preserves.
      const reauth = await svc.upsertFromOidc('plex', map({ sub: 'p1', email: 'not-an-email' }, null));
      expect(reauth.user.id).toBe(created.user.id);
      expect(reauth.user.email).toBe('good@x.com'); // preserved, never overwritten with garbage
    });

    it('a returning identity whose IdP now emits an over-length claim keeps its last-known-good email', async () => {
      await svc.upsertFromOidc('plex', prof('p1', 'todd', 'good@x.com'));
      const over = `${'a'.repeat(250)}@example.com`;
      const reauth = await svc.upsertFromOidc('plex', map({ sub: 'p1', email: over }, null));
      expect(reauth.user.email).toBe('good@x.com');
    });

    it('a NEW identity whose first claim is malformed is stored with a null email (no garbage persisted)', async () => {
      await svc.upsertFromOidc('plex', prof('first', 'admin')); // first user, becomes admin
      const created = await svc.upsertFromOidc('plex', map({ sub: 'p2', preferred_username: 'bob', email: 'garbage' }, null));
      expect(created.created).toBe(true);
      expect(created.user.email).toBeNull();
    });

    it('a NEW identity with a valid mixed-case/padded claim stores the normalized address', async () => {
      await svc.upsertFromOidc('plex', prof('first', 'admin'));
      const created = await svc.upsertFromOidc('plex', map({ sub: 'p3', preferred_username: 'sam', email: '  Sam@X.COM ' }, null));
      expect(created.user.email).toBe('sam@x.com');
    });
  });

  it('freezes profile metadata for a rejected user on re-login', async () => {
    await svc.upsertFromOidc('plex', prof('p1', 'first')); // becomes admin+active (first user)
    const target = await svc.upsertFromOidc('plex', prof('p2', 'frozen-name', 'a@x.com'));
    await svc.updateUser(target.user.publicId, { status: 'rejected' });

    const reauth = await svc.upsertFromOidc('plex', prof('p2', 'changed', 'b@x.com'));
    expect(reauth.created).toBe(false);
    expect(reauth.user).toMatchObject({ status: 'rejected', username: 'frozen-name', email: 'a@x.com' });
  });
});

describe('UserService local auth', () => {
  it('keys a local user on the lowercased email; display = local-part; email stored', async () => {
    const u = await svc.createLocalUser({ email: 'Todd@Example.com', passwordHash: 'hash' });
    expect(u.created).toBe(true);
    expect(u.user).toMatchObject({
      authProvider: 'local',
      authSubject: 'todd@example.com',
      username: 'todd',
      email: 'todd@example.com',
      role: 'admin',
      status: 'active',
    });
    expect((await svc.findLocalByEmail('TODD@EXAMPLE.COM'))?.id).toBe(u.user.id);
    expect((await svc.findLocalByEmail('todd@example.com'))?.passwordHash).toBe('hash');
  });

  it('a second local user lands pending', async () => {
    await svc.createLocalUser({ email: 'first@x.com', passwordHash: 'h' });
    const second = await svc.createLocalUser({ email: 'second@x.com', passwordHash: 'h' });
    expect(second.created).toBe(true);
    expect(second.user).toMatchObject({ role: 'user', status: 'pending' });
  });
});

describe('UserService createIdentity unique-violation race', () => {
  // createLocalUser() goes straight to createIdentity() (no preflight findByIdentity), so
  // forcing the insert to throw the unique violation drives the catch at :200-208: a unique
  // breach re-queries via findByIdentity and resolves to the existing row; anything else
  // (incl. a re-query miss) re-throws unchanged.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves a REAL unique violation to the existing identity (created=false)', async () => {
    // No insert spy: the seeded identity makes the real idx_users_provider_subject index
    // fire, so this proves the classifier against an actual drizzle error (whose top-level
    // message never names the constraint), not a synthetic one.
    const existing = await insertUser(db, {
      provider: 'local',
      subject: 'todd@example.com',
      username: 'todd',
    });

    // createLocalUser() lowercases + trims the email into authSubject, so this collides.
    const result = await svc.createLocalUser({ email: 'Todd@Example.com', passwordHash: 'h' });
    expect(result.created).toBe(false);
    expect(result.user.id).toBe(existing.id); // re-queried via findByIdentity, not a new signup
  });

  it('resolves a synthetic unique violation too (fast shape check)', async () => {
    const existing = await insertUser(db, {
      provider: 'local',
      subject: 'todd@example.com',
      username: 'todd',
    });
    vi.spyOn(db, 'insert').mockImplementation(() => {
      throw new Error('UNIQUE constraint failed: users.auth_provider, users.auth_subject');
    });

    const result = await svc.createLocalUser({ email: 'Todd@Example.com', passwordHash: 'h' });
    expect(result.created).toBe(false);
    expect(result.user.id).toBe(existing.id);
  });

  it('re-throws a non-unique error unchanged (the catch does not swallow it)', async () => {
    await insertUser(db, { provider: 'local', subject: 'todd@example.com', username: 'todd' });
    vi.spyOn(db, 'insert').mockImplementation(() => {
      throw new Error('boom');
    });
    await expect(svc.createLocalUser({ email: 'todd@example.com', passwordHash: 'h' })).rejects.toThrow('boom');
  });

  it('re-throws the ORIGINAL unique error object when the re-query finds no identity (no silent null)', async () => {
    // No seeded identity → findByIdentity misses after the matched violation → fallthrough.
    // The sentinel is drizzle-shaped (constraint text only on the cause) and identity-checked
    // with toBe: re-wrapping it in a fresh Error with the same message would discard the
    // driver's type/cause chain while still satisfying a message-only assertion.
    const original = new Error('Failed query: insert into "users" (...) values (...) returning ...', {
      cause: new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed: users.auth_provider, users.auth_subject'),
    });
    vi.spyOn(db, 'insert').mockImplementation(() => {
      throw original;
    });
    await expect(svc.createLocalUser({ email: 'ghost@x.com', passwordHash: 'h' })).rejects.toBe(original);
  });
});

describe('UserService BOOTSTRAP_ADMIN', () => {
  it('grants admin only to the pinned identity (by username) and disables first-user-admin', async () => {
    svc = new UserService(db, { bootstrapAdmin: { provider: 'authelia', value: 'todd' } });

    // First to arrive does NOT match the pin → pending, not admin.
    const stranger = await svc.upsertFromOidc('plex', prof('p1', 'stranger'));
    expect(stranger.user).toMatchObject({ role: 'user', status: 'pending' });

    // The pinned identity → admin + active.
    const owner = await svc.upsertFromOidc('authelia', prof('sub-todd', 'todd'));
    expect(owner.user).toMatchObject({ role: 'admin', status: 'active' });
  });

  it('matches the pin by exact subject too', async () => {
    svc = new UserService(db, { bootstrapAdmin: { provider: 'authelia', value: 'sub-xyz' } });
    const owner = await svc.upsertFromOidc('authelia', prof('sub-xyz', 'display'));
    expect(owner.user.role).toBe('admin');
  });
});

describe('UserService.ensureDevAdmin', () => {
  it('is idempotent and yields a local/active admin', async () => {
    const a = await svc.ensureDevAdmin();
    const b = await svc.ensureDevAdmin();
    expect(a.id).toBe(b.id);
    expect(a).toMatchObject({ authProvider: 'local', authSubject: 'dev-admin', role: 'admin', status: 'active' });
  });

  it('does NOT occupy the first-user slot: the first real user after a bypass run still becomes admin', async () => {
    // Simulates flipping AUTH_BYPASS=1 → standard on the same volume: the persisted
    // dev-admin must be excluded from the first-user count, or the first real signup
    // would land pending with no admin to approve it (bricked install).
    await svc.ensureDevAdmin();
    const firstReal = await svc.upsertFromOidc('plex', prof('p1', 'todd'));
    expect(firstReal.user).toMatchObject({ role: 'admin', status: 'active' });
  });
});
