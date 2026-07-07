import { describe, it, expect } from 'vitest';
import {
  NOTIFY_TRANSITION_LABELS,
  toggleNotifyOn,
  optInDisabled,
  providerLabel,
  isEmailDirty,
  emailPatchValue,
  reconciledEmailDraft,
} from './notify-prefs.js';
import { NOTIFIABLE_TRANSITIONS } from '@shared/schemas/user';

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

describe('isEmailDirty — email Save enablement (#131)', () => {
  it('is clean when the trimmed draft equals the stored value', () => {
    expect(isEmailDirty('todd@x.com', 'todd@x.com')).toBe(false);
    expect(isEmailDirty('todd@x.com', '  todd@x.com  ')).toBe(false);
  });
  it('treats a null stored contact as the empty string', () => {
    expect(isEmailDirty(null, '')).toBe(false);
    expect(isEmailDirty(null, '   ')).toBe(false);
    expect(isEmailDirty(null, 'new@x.com')).toBe(true);
  });
  it('is dirty when the draft differs (edit or clear)', () => {
    expect(isEmailDirty('todd@x.com', 'other@x.com')).toBe(true);
    expect(isEmailDirty('todd@x.com', '')).toBe(true); // clearing the field
  });
});

describe('emailPatchValue — PATCH body email from the draft (#131)', () => {
  it('sends null for an empty / whitespace-only field (clears the contact)', () => {
    expect(emailPatchValue('')).toBeNull();
    expect(emailPatchValue('   ')).toBeNull();
  });
  it('sends the trimmed value otherwise (server normalizes + validates)', () => {
    expect(emailPatchValue('  New@X.com ')).toBe('New@X.com');
    expect(emailPatchValue('new@x.com')).toBe('new@x.com');
  });
});

describe('reconciledEmailDraft — post-save draft reset leaves Save clean (#131 F2)', () => {
  it('adopts the server-normalized value so a case-normalized save is no longer dirty', () => {
    // The user typed `New@Contact.COM`; the server returns it normalized as `new@contact.com`.
    const saved = 'new@contact.com';
    const draft = reconciledEmailDraft(saved);
    expect(draft).toBe('new@contact.com'); // reconciled to the returned DTO value
    expect(isEmailDirty(saved, draft)).toBe(false); // Save is no longer falsely amber/enabled
  });
  it('maps a cleared contact (null) to an empty draft that reads clean', () => {
    const draft = reconciledEmailDraft(null);
    expect(draft).toBe('');
    expect(isEmailDirty(null, draft)).toBe(false);
  });
  it('reconciling the saved value is idempotent-clean for any returned contact', () => {
    for (const saved of ['todd@x.com', null]) {
      expect(isEmailDirty(saved, reconciledEmailDraft(saved))).toBe(false);
    }
  });
});
