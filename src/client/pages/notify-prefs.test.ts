import { describe, it, expect } from 'vitest';
import {
  NOTIFY_TRANSITION_LABELS,
  toggleNotifyOn,
  optInDisabled,
  providerLabel,
  isEmailFieldDirty,
  emailFieldPatchValue,
  reconciledEmailFieldDraft,
  meSuccessToast,
  mergeMeCache,
  KINDLE_EMAIL_HELP,
} from './notify-prefs.js';
import { NOTIFIABLE_TRANSITIONS, type MeDto } from '@shared/schemas/user';

describe('NOTIFY_TRANSITION_LABELS', () => {
  it('has a label for every transition, in const order (approved/denied/ready to listen)', () => {
    expect(NOTIFIABLE_TRANSITIONS.map((t) => NOTIFY_TRANSITION_LABELS[t])).toEqual([
      'approved',
      'denied',
      'ready to listen',
    ]);
  });
});

describe('toggleNotifyOn', () => {
  it('adds a transition when enabled', () => {
    expect(toggleNotifyOn([], 'available', true)).toEqual(['available']);
  });

  it('removes a transition when disabled', () => {
    expect(toggleNotifyOn(['available'], 'available', false)).toEqual([]);
  });

  it('is idempotent — enabling an already-present transition does not duplicate it', () => {
    expect(toggleNotifyOn(['available'], 'available', true)).toEqual(['available']);
  });

  it('does not mutate the input array', () => {
    const current: ('available')[] = [];
    toggleNotifyOn(current, 'available', true);
    expect(current).toEqual([]);
  });

  it('orders the result by NOTIFIABLE_TRANSITIONS regardless of click order (stable payload)', () => {
    // Enable in reverse const order; the payload must come back in const order (approved, denied, available).
    let set = toggleNotifyOn([], 'available', true);
    set = toggleNotifyOn(set, 'approved', true);
    set = toggleNotifyOn(set, 'denied', true);
    expect(set).toEqual(['approved', 'denied', 'available']);
  });
});

describe('optInDisabled', () => {
  it('is disabled when email delivery is unavailable', () => {
    expect(optInDisabled(false)).toBe(true);
  });
  it('is enabled when email delivery is available', () => {
    expect(optInDisabled(true)).toBe(false);
  });
});

describe('providerLabel — identity provider line copy (#131)', () => {
  const providers = [
    { id: 'authelia', label: 'Authelia SSO' },
    { id: 'keycloak', label: 'Company Login' },
  ];
  it('maps local → "email"', () => {
    expect(providerLabel('local', providers)).toBe('email');
  });
  it('maps plex → "Plex"', () => {
    expect(providerLabel('plex', providers)).toBe('Plex');
  });
  it('resolves a configured OIDC id to its label', () => {
    expect(providerLabel('authelia', providers)).toBe('Authelia SSO');
    expect(providerLabel('keycloak', providers)).toBe('Company Login');
  });
  it('falls back to the raw id when no configured label matches (unknown id / empty list)', () => {
    expect(providerLabel('mystery', providers)).toBe('mystery');
    expect(providerLabel('authelia', [])).toBe('authelia');
  });
});

describe('isEmailFieldDirty — email Save enablement (#131)', () => {
  it('is clean when the trimmed draft equals the stored value', () => {
    expect(isEmailFieldDirty('todd@x.com', 'todd@x.com')).toBe(false);
    expect(isEmailFieldDirty('todd@x.com', '  todd@x.com  ')).toBe(false);
  });
  it('treats a null stored contact as the empty string', () => {
    expect(isEmailFieldDirty(null, '')).toBe(false);
    expect(isEmailFieldDirty(null, '   ')).toBe(false);
    expect(isEmailFieldDirty(null, 'new@x.com')).toBe(true);
  });
  it('is dirty when the draft differs (edit or clear)', () => {
    expect(isEmailFieldDirty('todd@x.com', 'other@x.com')).toBe(true);
    expect(isEmailFieldDirty('todd@x.com', '')).toBe(true); // clearing the field
  });
});

describe('emailFieldPatchValue — PATCH body email from the draft (#131)', () => {
  it('sends null for an empty / whitespace-only field (clears the contact)', () => {
    expect(emailFieldPatchValue('')).toBeNull();
    expect(emailFieldPatchValue('   ')).toBeNull();
  });
  it('sends the trimmed value otherwise (server normalizes + validates)', () => {
    expect(emailFieldPatchValue('  New@X.com ')).toBe('New@X.com');
    expect(emailFieldPatchValue('new@x.com')).toBe('new@x.com');
  });
});

describe('reconciledEmailFieldDraft — post-save draft reset leaves Save clean (#131 F2)', () => {
  it('adopts the server-normalized value so a case-normalized save is no longer dirty', () => {
    // The user typed `New@Contact.COM`; the server returns it normalized as `new@contact.com`.
    const saved = 'new@contact.com';
    const draft = reconciledEmailFieldDraft(saved);
    expect(draft).toBe('new@contact.com'); // reconciled to the returned DTO value
    expect(isEmailFieldDirty(saved, draft)).toBe(false); // Save is no longer falsely amber/enabled
  });
  it('maps a cleared contact (null) to an empty draft that reads clean', () => {
    const draft = reconciledEmailFieldDraft(null);
    expect(draft).toBe('');
    expect(isEmailFieldDirty(null, draft)).toBe(false);
  });
  it('reconciling the saved value is idempotent-clean for any returned contact', () => {
    for (const saved of ['todd@x.com', null]) {
      expect(isEmailFieldDirty(saved, reconciledEmailFieldDraft(saved))).toBe(false);
    }
  });
});

// The three helpers above are FIELD-GENERIC — the Kindle-address row (#142) reuses them rather than
// owning clones. These pin the Kindle row's cases against the same functions, so a future clone that
// re-introduces the case-normalization false-dirty bug shows up as a diverging pair of suites.
describe('the Kindle-address row reuses the same field helpers (#142)', () => {
  describe('isEmailFieldDirty — Kindle Save enablement', () => {
    it('is clean when the stored address is null and the draft is empty/whitespace', () => {
      expect(isEmailFieldDirty(null, '')).toBe(false);
      expect(isEmailFieldDirty(null, '   ')).toBe(false);
    });
    it('is clean when the trimmed draft equals the stored address', () => {
      expect(isEmailFieldDirty('device@kindle.com', 'device@kindle.com')).toBe(false);
      expect(isEmailFieldDirty('device@kindle.com', '  device@kindle.com  ')).toBe(false);
    });
    it('is dirty for any different value (edit, set-from-empty, or clear)', () => {
      expect(isEmailFieldDirty('device@kindle.com', 'other@kindle.com')).toBe(true);
      expect(isEmailFieldDirty(null, 'device@kindle.com')).toBe(true);
      expect(isEmailFieldDirty('device@kindle.com', '')).toBe(true);
    });
  });

  describe('emailFieldPatchValue — the kindleEmail PATCH value', () => {
    it('sends null for an empty / whitespace-only field (clears the address)', () => {
      expect(emailFieldPatchValue('')).toBeNull();
      expect(emailFieldPatchValue('   ')).toBeNull();
    });
    it('sends the trimmed value otherwise — the SERVER lowercases, the client only trims', () => {
      expect(emailFieldPatchValue('  A@Kindle.com ')).toBe('A@Kindle.com');
      expect(emailFieldPatchValue('device@kindle.com')).toBe('device@kindle.com');
    });
  });

  describe('reconciledEmailFieldDraft — post-save reconcile invariant', () => {
    it('leaves the Kindle row clean for a saved value and for a cleared (null) address', () => {
      // The user typed `Device@KINDLE.COM`; the server returns `device@kindle.com`.
      for (const saved of ['device@kindle.com', null]) {
        expect(isEmailFieldDirty(saved, reconciledEmailFieldDraft(saved))).toBe(false);
      }
    });
  });

  it('KINDLE_EMAIL_HELP names where Amazon shows the device address', () => {
    expect(KINDLE_EMAIL_HELP).toContain('Amazon');
    expect(KINDLE_EMAIL_HELP).toContain('Devices');
    expect(KINDLE_EMAIL_HELP).toContain('Email');
  });
});

describe('meSuccessToast — success feedback proportional to the payload (#134)', () => {
  it('toasts "Email saved" when the body sets an email (explicit commit deserves an ack)', () => {
    expect(meSuccessToast({ email: 'new@x.com' })).toBe('Email saved');
  });
  it('toasts "Email saved" when the body clears the email (email: null)', () => {
    expect(meSuccessToast({ email: null })).toBe('Email saved');
  });
  it('is silent (null) for a notifyOn-only body — the persisted checkbox is the confirmation', () => {
    expect(meSuccessToast({ notifyOn: ['available'] })).toBeNull();
    expect(meSuccessToast({ notifyOn: [] })).toBeNull();
  });
  it('is silent (null) for an empty body (nothing changed)', () => {
    expect(meSuccessToast({})).toBeNull();
  });
  it('prefers "Email saved" when both fields ride one body (the explicit-commit action wins)', () => {
    expect(meSuccessToast({ email: 'new@x.com', notifyOn: ['available'] })).toBe('Email saved');
    expect(meSuccessToast({ email: null, notifyOn: [] })).toBe('Email saved');
  });

  // #142: without this branch a kindleEmail-only body returns null and the explicit Kindle Save
  // applies with ZERO feedback — the field looks identical before and after.
  describe('kindleEmail (#142)', () => {
    it('toasts a distinct, non-null message for a kindleEmail-only body', () => {
      const message = meSuccessToast({ kindleEmail: 'device@kindle.com' });
      expect(message).not.toBeNull();
      expect(message).not.toBe('Email saved'); // distinct from the contact-email ack
      expect(message).toBe('Kindle address saved');
    });
    it('toasts for a kindleEmail: null clear too (keyed on the KEY, not the value)', () => {
      expect(meSuccessToast({ kindleEmail: null })).toBe('Kindle address saved');
    });
    it('stays silent for a notifyOn-only body — the new branch did not widen the silent case', () => {
      expect(meSuccessToast({ notifyOn: ['available'] })).toBeNull();
      expect(meSuccessToast({})).toBeNull();
    });
    it('an email-only body still returns "Email saved" (no regression)', () => {
      expect(meSuccessToast({ email: 'new@x.com' })).toBe('Email saved');
    });
    it('a body carrying BOTH addresses resolves email-first — deterministic, one toast', () => {
      expect(meSuccessToast({ email: 'new@x.com', kindleEmail: 'device@kindle.com' })).toBe('Email saved');
      expect(meSuccessToast({ email: null, kindleEmail: null })).toBe('Email saved');
    });
  });
});

// #142 F1 — the race-safe cache fold. The account rows own independent mutation instances, so their
// PATCHes overlap; each response is a snapshot in which the SIBLING field still holds its pre-write
// value. Replacing the whole cache entry with whichever response lands last rolls the newer sibling
// save back. These pin the rule: a response is authoritative only for the fields its body wrote.
describe('mergeMeCache — a response is authoritative only for what it wrote (#142 F1)', () => {
  const cached = {
    email: 'old@x.com',
    emailNotifyAvailable: false,
    kindleEmail: 'old@kindle.com',
    notifyOn: ['approved'],
    quota: { mode: 'limited', limit: 10, used: 1, remaining: 9, windowDays: 30 },
    username: 'todd',
  } as unknown as MeDto;

  /** A response carrying every field, with each SIBLING at a value that must not be adopted. */
  const response = {
    email: 'new@x.com',
    emailNotifyAvailable: true,
    kindleEmail: null,
    notifyOn: [],
    quota: { mode: 'limited', limit: 10, used: 4, remaining: 6, windowDays: 30 },
    username: 'todd',
  } as unknown as MeDto;

  it('takes the response whole when there is no prior cache entry', () => {
    expect(mergeMeCache(undefined, response, { email: 'new@x.com' })).toBe(response);
  });

  it('an email-only body adopts email + emailNotifyAvailable and preserves the siblings', () => {
    const merged = mergeMeCache(cached, response, { email: 'new@x.com' });
    expect(merged.email).toBe('new@x.com');
    expect(merged.emailNotifyAvailable).toBe(true); // derived from email — moves with it
    expect(merged.kindleEmail).toBe('old@kindle.com'); // NOT rolled back to the response's null
    expect(merged.notifyOn).toEqual(['approved']);
  });

  it('a kindleEmail-only body adopts kindleEmail and preserves the siblings', () => {
    const merged = mergeMeCache(cached, { ...response, kindleEmail: 'device@kindle.com' }, {
      kindleEmail: 'device@kindle.com',
    });
    expect(merged.kindleEmail).toBe('device@kindle.com');
    expect(merged.email).toBe('old@x.com'); // NOT rolled back to the response's new@x.com
    expect(merged.emailNotifyAvailable).toBe(false); // stays with the preserved email
    expect(merged.notifyOn).toEqual(['approved']);
  });

  it('a notifyOn-only body adopts notifyOn and preserves both addresses', () => {
    const merged = mergeMeCache(cached, { ...response, notifyOn: ['available'] }, { notifyOn: ['available'] });
    expect(merged.notifyOn).toEqual(['available']);
    expect(merged.email).toBe('old@x.com');
    expect(merged.kindleEmail).toBe('old@kindle.com');
  });

  it('keys on the KEY, not the value — an explicit null clear is an authoritative write', () => {
    expect(mergeMeCache(cached, { ...response, kindleEmail: null }, { kindleEmail: null }).kindleEmail).toBeNull();
    expect(mergeMeCache(cached, { ...response, email: null }, { email: null }).email).toBeNull();
  });

  it('an empty body preserves all three self-scoped fields', () => {
    const merged = mergeMeCache(cached, response, {});
    expect(merged).toMatchObject({
      email: 'old@x.com',
      emailNotifyAvailable: false,
      kindleEmail: 'old@kindle.com',
      notifyOn: ['approved'],
    });
  });

  it('takes non-self-scoped fields from the fresher response (they are not written here)', () => {
    // `quota` moves with request activity, not with this endpoint — no sibling to roll back.
    expect(mergeMeCache(cached, response, { kindleEmail: 'device@kindle.com' }).quota).toEqual(response.quota);
  });

  // The end-to-end property the race depends on: applying the two overlapping responses in EITHER
  // order converges on the same cache, with both saved values intact.
  it('converges on both saved values regardless of settlement order', () => {
    const base = { ...cached, email: 'old@x.com', kindleEmail: null } as MeDto;
    const contactRes = { ...base, email: 'new@x.com', kindleEmail: null } as MeDto; // sibling pre-write
    const kindleRes = { ...base, email: 'old@x.com', kindleEmail: 'device@kindle.com' } as MeDto;

    const contactLast = mergeMeCache(
      mergeMeCache(base, kindleRes, { kindleEmail: 'device@kindle.com' }),
      contactRes,
      { email: 'new@x.com' },
    );
    const kindleLast = mergeMeCache(
      mergeMeCache(base, contactRes, { email: 'new@x.com' }),
      kindleRes,
      { kindleEmail: 'device@kindle.com' },
    );

    for (const merged of [contactLast, kindleLast]) {
      expect(merged.email).toBe('new@x.com');
      expect(merged.kindleEmail).toBe('device@kindle.com');
    }
  });
});
