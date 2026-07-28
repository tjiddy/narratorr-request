import { describe, it, expect } from 'vitest';
import {
  updateUserBodySchema,
  requestQuotaSchema,
  userDtoSchema,
  localCredentialsSchema,
  NOTIFIABLE_TRANSITIONS,
  notifiableTransitionSchema,
  sanitizeNotifyOn,
  hasNotifyOn,
  updateMeBodySchema,
  contactEmailSchema,
  kindleEmailSchema,
  normalizeContactEmail,
  hasDeliverableContact,
  isApprovedUser,
  unapprovedStatus,
  USER_ROLES,
  USER_STATUSES,
} from './user.js';

describe('requestQuotaSchema — four-mode discriminated union', () => {
  it('accepts each mode in its valid shape', () => {
    expect(requestQuotaSchema.safeParse({ mode: 'inherit' }).success).toBe(true);
    expect(requestQuotaSchema.safeParse({ mode: 'unlimited' }).success).toBe(true);
    expect(requestQuotaSchema.safeParse({ mode: 'limited', limit: 5 }).success).toBe(true);
    expect(requestQuotaSchema.safeParse({ mode: 'blocked' }).success).toBe(true);
  });

  it('rejects a limit on a non-limited mode', () => {
    expect(requestQuotaSchema.safeParse({ mode: 'inherit', limit: 5 }).success).toBe(false);
    expect(requestQuotaSchema.safeParse({ mode: 'unlimited', limit: 5 }).success).toBe(false);
    expect(requestQuotaSchema.safeParse({ mode: 'blocked', limit: 5 }).success).toBe(false);
  });

  it('rejects a missing / 0 / negative / non-integer limit on limited', () => {
    expect(requestQuotaSchema.safeParse({ mode: 'limited' }).success).toBe(false);
    expect(requestQuotaSchema.safeParse({ mode: 'limited', limit: 0 }).success).toBe(false);
    expect(requestQuotaSchema.safeParse({ mode: 'limited', limit: -3 }).success).toBe(false);
    expect(requestQuotaSchema.safeParse({ mode: 'limited', limit: 1.5 }).success).toBe(false);
  });

  it('rejects an unknown mode', () => {
    expect(requestQuotaSchema.safeParse({ mode: 'banned' }).success).toBe(false);
  });
});

describe('userDtoSchema.requestQuota — the read shape is the same union', () => {
  const base = {
    publicId: 'us_1',
    username: 'u',
    authProvider: 'local',
    email: null,
    thumb: null,
    role: 'user' as const,
    status: 'active' as const,
    autoApprove: false,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  it('validates each mode as the read DTO', () => {
    for (const requestQuota of [{ mode: 'inherit' }, { mode: 'unlimited' }, { mode: 'limited', limit: 4 }, { mode: 'blocked' }]) {
      expect(userDtoSchema.safeParse({ ...base, requestQuota }).success).toBe(true);
    }
  });
});

describe('updateUserBodySchema', () => {
  describe('requestQuota — requestQuotaSchema.optional()', () => {
    it('rejects a bare number / null (the overloaded shape is gone)', () => {
      expect(updateUserBodySchema.safeParse({ requestQuota: 3 }).success).toBe(false);
      expect(updateUserBodySchema.safeParse({ requestQuota: null }).success).toBe(false);
    });

    it('accepts a mode object and an absent field (omit = no change)', () => {
      expect(updateUserBodySchema.safeParse({ requestQuota: { mode: 'limited', limit: 3 } }).success).toBe(true);
      expect(updateUserBodySchema.safeParse({ requestQuota: { mode: 'inherit' } }).success).toBe(true);
      expect(updateUserBodySchema.safeParse({}).success).toBe(true);
    });
  });

  describe('role enum (case-sensitive)', () => {
    it('accepts admin and user', () => {
      expect(updateUserBodySchema.safeParse({ role: 'admin' }).success).toBe(true);
      expect(updateUserBodySchema.safeParse({ role: 'user' }).success).toBe(true);
    });

    it('rejects out-of-set and wrong-case values', () => {
      expect(updateUserBodySchema.safeParse({ role: 'Admin' }).success).toBe(false);
      expect(updateUserBodySchema.safeParse({ role: 'owner' }).success).toBe(false);
    });
  });

  describe('status enum (case-sensitive)', () => {
    it('accepts pending, active, rejected', () => {
      expect(updateUserBodySchema.safeParse({ status: 'pending' }).success).toBe(true);
      expect(updateUserBodySchema.safeParse({ status: 'active' }).success).toBe(true);
      expect(updateUserBodySchema.safeParse({ status: 'rejected' }).success).toBe(true);
    });

    it('rejects out-of-set and wrong-case values', () => {
      expect(updateUserBodySchema.safeParse({ status: 'invalid' }).success).toBe(false);
      expect(updateUserBodySchema.safeParse({ status: 'Active' }).success).toBe(false);
    });
  });

  describe('.strict()', () => {
    it('rejects an unknown key', () => {
      expect(updateUserBodySchema.safeParse({ role: 'admin', extra: 1 }).success).toBe(false);
    });
  });
});

describe('localCredentialsSchema', () => {
  const pw = 'x'.repeat(8);

  describe('email — trim + lowercase + valid email + max(254)', () => {
    it('accepts a valid 254-char address and rejects 255', () => {
      // '@example.com' is 12 chars; pad the local part to hit the boundary exactly.
      const email254 = `${'a'.repeat(242)}@example.com`;
      const email255 = `${'a'.repeat(243)}@example.com`;
      expect(email254.length).toBe(254);
      expect(email255.length).toBe(255);
      expect(localCredentialsSchema.safeParse({ email: email254, password: pw }).success).toBe(true);
      expect(localCredentialsSchema.safeParse({ email: email255, password: pw }).success).toBe(false);
    });

    it('rejects a malformed address', () => {
      expect(localCredentialsSchema.safeParse({ email: 'notanemail', password: pw }).success).toBe(false);
    });

    it('rejects a whitespace-only email — .trim() empties it before z.email() (path points at email)', () => {
      // The .trim() before the z.email() pipe is load-bearing: '   ' trims to '' which
      // is not a valid email. Asserting the path catches a regression that drops the trim.
      const result = localCredentialsSchema.safeParse({ email: '   ', password: pw });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(['email']);
    });

    it('trims and lowercases the email (the normalized value is the subject key)', () => {
      const parsed = localCredentialsSchema.parse({ email: '  USER@EXAMPLE.COM ', password: pw });
      expect(parsed.email).toBe('user@example.com');
    });
  });

  describe('password — min(8).max(200)', () => {
    it('rejects 7 chars, accepts 8 and 200, rejects 201', () => {
      expect(localCredentialsSchema.safeParse({ email: 'user@x.com', password: 'x'.repeat(7) }).success).toBe(false);
      expect(localCredentialsSchema.safeParse({ email: 'user@x.com', password: 'x'.repeat(8) }).success).toBe(true);
      expect(localCredentialsSchema.safeParse({ email: 'user@x.com', password: 'x'.repeat(200) }).success).toBe(true);
      expect(localCredentialsSchema.safeParse({ email: 'user@x.com', password: 'x'.repeat(201) }).success).toBe(false);
    });
  });

  describe('.strict()', () => {
    it('rejects an unknown key', () => {
      expect(localCredentialsSchema.safeParse({ email: 'user@x.com', password: pw, extra: 1 }).success).toBe(false);
    });
  });
});

describe('contactEmailSchema / normalizeContactEmail / hasDeliverableContact (issue #120)', () => {
  it('localCredentialsSchema.email reuses the shared contactEmailSchema (same shape, no drift)', () => {
    // The local-login email IS contactEmailSchema — parsing the extracted schema directly
    // must produce the same normalized value the login form relies on.
    expect(contactEmailSchema.parse('  USER@EXAMPLE.COM ')).toBe('user@example.com');
    expect(contactEmailSchema.safeParse('notanemail').success).toBe(false);
  });

  describe('normalizeContactEmail', () => {
    it('returns the trimmed + lowercased address for a valid claim', () => {
      expect(normalizeContactEmail('  T@X.COM ')).toBe('t@x.com');
    });
    it('collapses null/undefined/empty/whitespace to null', () => {
      expect(normalizeContactEmail(null)).toBeNull();
      expect(normalizeContactEmail(undefined)).toBeNull();
      expect(normalizeContactEmail('')).toBeNull();
      expect(normalizeContactEmail('   ')).toBeNull();
    });
    it('collapses a malformed or over-length (>254) value to null', () => {
      expect(normalizeContactEmail('not-an-email')).toBeNull();
      expect(normalizeContactEmail(`${'a'.repeat(250)}@example.com`)).toBeNull();
    });
  });

  describe('hasDeliverableContact — the shared UI/sweep predicate', () => {
    it('is true only for a parseable address; false for null/empty/whitespace/malformed', () => {
      expect(hasDeliverableContact('user@x.com')).toBe(true);
      expect(hasDeliverableContact('  User@X.COM ')).toBe(true);
      expect(hasDeliverableContact(null)).toBe(false);
      expect(hasDeliverableContact('')).toBe(false);
      expect(hasDeliverableContact('  ')).toBe(false);
      expect(hasDeliverableContact('garbage')).toBe(false);
    });
  });
});

describe('kindleEmailSchema — Send-to-Kindle device address (#142)', () => {
  describe('accepts + normalizes a real kindle.com address', () => {
    it('trims and lowercases before the domain check runs (post-normalization refinement)', () => {
      expect(kindleEmailSchema.parse('  USER@KINDLE.COM ')).toBe('user@kindle.com');
      expect(kindleEmailSchema.parse('User@Kindle.Com')).toBe('user@kindle.com');
    });
    it('accepts the dot/plus local-part forms Amazon issues', () => {
      expect(kindleEmailSchema.parse('a.b+tag@kindle.com')).toBe('a.b+tag@kindle.com');
    });
  });

  // Each rejection is asserted individually so a broadened matcher (a bare `.endsWith` or
  // `.includes`) fails loudly on the exact case it would let through.
  describe('rejects anything whose domain is not exactly kindle.com', () => {
    it('rejects a subdomain (a@sub.kindle.com)', () => {
      expect(kindleEmailSchema.safeParse('a@sub.kindle.com').success).toBe(false);
    });
    it('rejects a suffix-match lookalike (a@notkindle.com)', () => {
      expect(kindleEmailSchema.safeParse('a@notkindle.com').success).toBe(false);
    });
    it('rejects a suffix-match lookalike (a@evilkindle.com)', () => {
      expect(kindleEmailSchema.safeParse('a@evilkindle.com').success).toBe(false);
    });
    it('rejects a contains-match lookalike (a@kindle.com.evil.io)', () => {
      expect(kindleEmailSchema.safeParse('a@kindle.com.evil.io').success).toBe(false);
    });
    it('rejects a near-miss TLD (a@kindle.co)', () => {
      expect(kindleEmailSchema.safeParse('a@kindle.co').success).toBe(false);
    });
    it('rejects an ordinary contact domain (a@example.com)', () => {
      expect(kindleEmailSchema.safeParse('a@example.com').success).toBe(false);
    });
    // Amazon's Wi-Fi-only free-delivery domain is deliberately NOT accepted (spec Open Question):
    // widening the domain set is a product decision, not something to broaden silently.
    it('rejects the free-delivery domain (a@free.kindle.com) — deliberately out of scope', () => {
      expect(kindleEmailSchema.safeParse('a@free.kindle.com').success).toBe(false);
    });
  });

  describe('inherits the shared mailbox contract from contactEmailSchema', () => {
    it('rejects a structurally invalid address', () => {
      expect(kindleEmailSchema.safeParse('not-an-email').success).toBe(false);
      expect(kindleEmailSchema.safeParse('kindle.com').success).toBe(false);
    });
    it('rejects "" and whitespace-only (clearing is kindleEmail: null only)', () => {
      expect(kindleEmailSchema.safeParse('').success).toBe(false);
      expect(kindleEmailSchema.safeParse('   ').success).toBe(false);
    });
    it('rejects an over-254 address', () => {
      expect(kindleEmailSchema.safeParse(`${'a'.repeat(250)}@kindle.com`).success).toBe(false);
    });
  });

  it('does NOT leak its domain constraint back into the shared contactEmailSchema', () => {
    // kindleEmailSchema is DERIVED from contactEmailSchema; a refinement applied to the shared
    // schema in place (rather than to a derived copy) would break every contact-email caller.
    expect(contactEmailSchema.parse('a@example.com')).toBe('a@example.com');
    expect(contactEmailSchema.parse('  Todd@Example.COM ')).toBe('todd@example.com');
  });
});

describe('NOTIFIABLE_TRANSITIONS — requester opt-in (#50/#131)', () => {
  it('ships approved/denied/available in lifecycle order — each has a live emit site', () => {
    expect(NOTIFIABLE_TRANSITIONS).toEqual(['approved', 'denied', 'available']);
  });
});

describe('notifiableTransitionSchema', () => {
  it('accepts every in-const value', () => {
    for (const good of ['approved', 'denied', 'available']) {
      expect(notifiableTransitionSchema.safeParse(good).success).toBe(true);
    }
  });
  it('rejects a value outside the const (a RequestStatus with no emit site, or garbage)', () => {
    for (const bad of ['failed', 'pending', 'acquiring', 'bogus', '']) {
      expect(notifiableTransitionSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('sanitizeNotifyOn — degrade-to-empty on a corrupt/legacy read', () => {
  it('passes a clean array through (including the new transitions, subset-of-const)', () => {
    expect(sanitizeNotifyOn(['available'])).toEqual(['available']);
    expect(sanitizeNotifyOn(['approved', 'denied'])).toEqual(['approved', 'denied']);
  });
  it('degrades a non-array / legacy / unknown value to empty', () => {
    for (const bad of [null, undefined, 42, 'available', {}, ['available', 'failed'], ['bogus']]) {
      expect(sanitizeNotifyOn(bad)).toEqual([]);
    }
  });
  it('collapses duplicates', () => {
    expect(sanitizeNotifyOn(['available', 'available'])).toEqual(['available']);
  });
  it('hasNotifyOn is true iff sanitizeNotifyOn yields a real opt-in', () => {
    expect(hasNotifyOn(['available'])).toBe(true);
    expect(hasNotifyOn(['approved'])).toBe(true);
    expect(hasNotifyOn(['bogus'])).toBe(false); // outside the const → degrades to empty → no opt-in
    expect(hasNotifyOn([])).toBe(false);
    expect(hasNotifyOn('not-an-array')).toBe(false); // non-array degrades to empty, like sanitizeNotifyOn
  });
});

describe('updateMeBodySchema (PATCH /api/me)', () => {
  it('accepts a valid notifyOn set (including the new approved/denied and empty)', () => {
    expect(updateMeBodySchema.safeParse({ notifyOn: ['available'] }).success).toBe(true);
    expect(updateMeBodySchema.safeParse({ notifyOn: ['approved', 'denied'] }).success).toBe(true);
    expect(updateMeBodySchema.safeParse({ notifyOn: [] }).success).toBe(true);
  });
  it('rejects a value outside NOTIFIABLE_TRANSITIONS (→ 400)', () => {
    expect(updateMeBodySchema.safeParse({ notifyOn: ['failed'] }).success).toBe(false);
    expect(updateMeBodySchema.safeParse({ notifyOn: ['pending'] }).success).toBe(false);
  });
  it('is strict — a stray key (e.g. smuggling role) is rejected', () => {
    expect(updateMeBodySchema.safeParse({ notifyOn: ['available'], role: 'admin' }).success).toBe(false);
  });

  describe('email — set / clear / omit contract (#131)', () => {
    it('omitting email (notifyOn-only) is valid — no contact change', () => {
      expect(updateMeBodySchema.safeParse({ notifyOn: ['available'] }).success).toBe(true);
    });
    it('an empty body is valid — email AND notifyOn are both optional (neither = no change)', () => {
      expect(updateMeBodySchema.safeParse({}).success).toBe(true);
    });
    it('email null is valid — the clear sentinel', () => {
      const parsed = updateMeBodySchema.safeParse({ email: null });
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.email).toBeNull();
    });
    it('a valid email is normalized (trim + lowercase) by the shared contactEmailSchema', () => {
      const parsed = updateMeBodySchema.safeParse({ email: '  Todd@Example.COM ' });
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.email).toBe('todd@example.com');
    });
    it('email and notifyOn are independent — a body may carry both', () => {
      expect(updateMeBodySchema.safeParse({ email: 'a@b.com', notifyOn: ['approved'] }).success).toBe(true);
    });
    it('email "" is a 400 (NOT a clear) — contactEmailSchema rejects the empty string', () => {
      expect(updateMeBodySchema.safeParse({ email: '' }).success).toBe(false);
    });
    it('rejects an invalid / whitespace-only / over-254 email (→ 400)', () => {
      expect(updateMeBodySchema.safeParse({ email: 'not-an-email' }).success).toBe(false);
      expect(updateMeBodySchema.safeParse({ email: '   ' }).success).toBe(false);
      expect(updateMeBodySchema.safeParse({ email: `${'a'.repeat(250)}@example.com` }).success).toBe(false);
    });
  });

  describe('kindleEmail — set / clear / omit contract (#142)', () => {
    it('a valid Kindle address is normalized by the shared kindleEmailSchema', () => {
      const parsed = updateMeBodySchema.safeParse({ kindleEmail: '  Todd@KINDLE.com ' });
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.kindleEmail).toBe('todd@kindle.com');
    });
    it('kindleEmail null is valid — the clear sentinel', () => {
      const parsed = updateMeBodySchema.safeParse({ kindleEmail: null });
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.kindleEmail).toBeNull();
    });
    it('omitting kindleEmail is valid — no change (an empty body stays a no-op)', () => {
      expect(updateMeBodySchema.safeParse({}).success).toBe(true);
      expect(updateMeBodySchema.safeParse({ notifyOn: ['available'] }).success).toBe(true);
    });
    it('kindleEmail "" is a 400 (NOT a clear) — same semantics as email', () => {
      expect(updateMeBodySchema.safeParse({ kindleEmail: '' }).success).toBe(false);
      expect(updateMeBodySchema.safeParse({ kindleEmail: '   ' }).success).toBe(false);
    });
    it('rejects a non-kindle.com domain (→ 400)', () => {
      expect(updateMeBodySchema.safeParse({ kindleEmail: 'a@example.com' }).success).toBe(false);
      expect(updateMeBodySchema.safeParse({ kindleEmail: 'a@evilkindle.com' }).success).toBe(false);
    });

    // The three self-scoped fields are mutually independent: every subset must parse.
    it('parses every subset of { notifyOn, email, kindleEmail }', () => {
      const subsets: Record<string, unknown>[] = [
        {},
        { notifyOn: ['approved'] },
        { email: 'a@b.com' },
        { kindleEmail: 'a@kindle.com' },
        { notifyOn: ['approved'], email: 'a@b.com' },
        { notifyOn: ['approved'], kindleEmail: 'a@kindle.com' },
        { email: 'a@b.com', kindleEmail: 'a@kindle.com' },
        { notifyOn: ['approved'], email: 'a@b.com', kindleEmail: 'a@kindle.com' },
        { email: null, kindleEmail: null },
      ];
      for (const body of subsets) expect(updateMeBodySchema.safeParse(body).success).toBe(true);
    });
    it('stays strict — a stray key alongside kindleEmail is rejected', () => {
      expect(updateMeBodySchema.safeParse({ kindleEmail: 'a@kindle.com', role: 'admin' }).success).toBe(false);
    });
  });
});

describe('isApprovedUser / unapprovedStatus — the shared approval-queue policy (#144)', () => {
  const MATRIX = USER_ROLES.flatMap((role) => USER_STATUSES.map((status) => ({ role, status })));

  it('admits an active user and ANY admin — the queue can never lock an admin out', () => {
    expect(isApprovedUser({ role: 'user', status: 'active' })).toBe(true);
    // An admin is approved at every status: role is orthogonal to the queue, and the person who
    // grants approvals must not be able to lock themselves out of the app that grants them.
    for (const status of USER_STATUSES) {
      expect(isApprovedUser({ role: 'admin', status }), status).toBe(true);
    }
  });

  it('rejects a non-admin who is not active', () => {
    expect(isApprovedUser({ role: 'user', status: 'pending' })).toBe(false);
    expect(isApprovedUser({ role: 'user', status: 'rejected' })).toBe(false);
  });

  it('unapprovedStatus is the exact negation, carrying the state to render', () => {
    // The two must agree on every input or `App.tsx`'s shell choice and the query/authorization
    // gates would answer differently for the same account.
    for (const user of MATRIX) {
      const unapproved = unapprovedStatus(user);
      expect(unapproved === null, JSON.stringify(user)).toBe(isApprovedUser(user));
      // …and when it does report a state, it is the account's own — never `active`.
      if (unapproved !== null) expect(unapproved).toBe(user.status);
    }
  });

  it('names both unapproved states for a non-admin', () => {
    expect(unapprovedStatus({ role: 'user', status: 'pending' })).toBe('pending');
    expect(unapprovedStatus({ role: 'user', status: 'rejected' })).toBe('rejected');
  });
});
