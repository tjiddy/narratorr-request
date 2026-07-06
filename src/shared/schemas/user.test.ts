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
  normalizeContactEmail,
  hasDeliverableContact,
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

describe('NOTIFIABLE_TRANSITIONS (v1) — requester opt-in (#50)', () => {
  it('ships `available` ONLY — no transition that lacks an emit site', () => {
    expect(NOTIFIABLE_TRANSITIONS).toEqual(['available']);
  });
});

describe('notifiableTransitionSchema', () => {
  it('accepts an in-const value', () => {
    expect(notifiableTransitionSchema.safeParse('available').success).toBe(true);
  });
  it('rejects a value outside the const (a RequestStatus with no emit site, or garbage)', () => {
    for (const bad of ['denied', 'failed', 'pending', 'approved', 'acquiring', '']) {
      expect(notifiableTransitionSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('sanitizeNotifyOn — degrade-to-empty on a corrupt/legacy read', () => {
  it('passes a clean array through', () => {
    expect(sanitizeNotifyOn(['available'])).toEqual(['available']);
  });
  it('degrades a non-array / legacy / unknown value to empty', () => {
    for (const bad of [null, undefined, 42, 'available', {}, ['available', 'denied'], ['bogus']]) {
      expect(sanitizeNotifyOn(bad)).toEqual([]);
    }
  });
  it('collapses duplicates', () => {
    expect(sanitizeNotifyOn(['available', 'available'])).toEqual(['available']);
  });
  it('hasNotifyOn is true iff sanitizeNotifyOn yields a real opt-in', () => {
    expect(hasNotifyOn(['available'])).toBe(true);
    expect(hasNotifyOn(['bogus'])).toBe(false); // outside the const → degrades to empty → no opt-in
    expect(hasNotifyOn([])).toBe(false);
    expect(hasNotifyOn('not-an-array')).toBe(false); // non-array degrades to empty, like sanitizeNotifyOn
  });
});

describe('updateMeBodySchema (PATCH /api/me)', () => {
  it('accepts a valid notifyOn set (including empty)', () => {
    expect(updateMeBodySchema.safeParse({ notifyOn: ['available'] }).success).toBe(true);
    expect(updateMeBodySchema.safeParse({ notifyOn: [] }).success).toBe(true);
  });
  it('rejects a value outside NOTIFIABLE_TRANSITIONS (→ 400)', () => {
    expect(updateMeBodySchema.safeParse({ notifyOn: ['denied'] }).success).toBe(false);
    expect(updateMeBodySchema.safeParse({ notifyOn: ['failed'] }).success).toBe(false);
  });
  it('is strict — a stray key (e.g. smuggling role) is rejected', () => {
    expect(updateMeBodySchema.safeParse({ notifyOn: ['available'], role: 'admin' }).success).toBe(false);
  });
  it('requires notifyOn', () => {
    expect(updateMeBodySchema.safeParse({}).success).toBe(false);
  });
});
