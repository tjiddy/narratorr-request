import { useId, useState } from 'react';
import type { MeDto } from '@shared/schemas/user';
import { NOTIFIABLE_TRANSITIONS } from '@shared/schemas/user';
import { ApiError } from '../api';
import { useUpdateMe, useAuthProviders } from '../hooks';
import {
  NOTIFY_TRANSITION_LABELS,
  toggleNotifyOn,
  optInDisabled,
  providerLabel,
  isEmailDirty,
  emailPatchValue,
} from '../pages/notify-prefs';
import { Dialog } from './Dialog';
import { BellIcon } from './icons';

/**
 * The account modal (issue #131), opened from the nav username. Bundles the account preferences that
 * used to live on My Requests: the contact email (with a row-scoped Save) and the requester-
 * notification opt-in checkboxes, above an identity header. Built on the reusable {@link Dialog}
 * primitive. Pure decision logic (dirty-state, provider label) lives in `notify-prefs.ts`.
 *
 * The inner body ({@link AccountModalContent}) only mounts while the dialog is open, so its email
 * draft `useState` initializes fresh from the stored contact on every open — no reset effect needed.
 */
export function AccountModal({ me, open, onClose }: { me: MeDto; open: boolean; onClose: () => void }) {
  const headingId = useId();
  return (
    <Dialog open={open} onClose={onClose} labelledBy={headingId}>
      <AccountModalContent me={me} headingId={headingId} />
    </Dialog>
  );
}

function AccountModalContent({ me, headingId }: { me: MeDto; headingId: string }) {
  const save = useUpdateMe();
  const { data: authProviders } = useAuthProviders();

  const [email, setEmail] = useState(me.email ?? '');
  const [emailError, setEmailError] = useState<string | null>(null);

  const initial = me.username.charAt(0).toUpperCase() || '?';
  const providers = authProviders?.providers ?? [];
  const dirty = isEmailDirty(me.email, email);
  const notifyDisabled = optInDisabled(me.emailNotifyAvailable);

  const saveEmail = () => {
    setEmailError(null);
    save.mutate(
      { email: emailPatchValue(email) },
      { onError: (err) => setEmailError(err instanceof ApiError ? err.message : 'Could not save email') },
    );
  };

  const onToggle = (transition: (typeof NOTIFIABLE_TRANSITIONS)[number], enabled: boolean) => {
    save.mutate({ notifyOn: toggleNotifyOn(me.notifyOn, transition, enabled) });
  };

  return (
    <div className="flex flex-col gap-6 p-6 sm:p-7">
        {/* Identity block — the header (no modal title): glow-haloed gradient avatar + name + provider. */}
        <div className="flex items-center gap-4">
          <div className="relative shrink-0">
            <div className="absolute inset-0 rounded-full bg-primary/30 blur-lg" />
            <div className="relative flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-primary to-amber-500 text-lg font-semibold text-primary-foreground">
              {initial}
            </div>
          </div>
          <div className="min-w-0">
            <h2 id={headingId} className="flex items-center gap-1.5 font-display text-[1.35rem] font-semibold leading-tight">
              <span className="truncate">{me.username}</span>
              {me.role === 'admin' && <span className="text-primary">★</span>}
            </h2>
            <p className="text-sm text-muted-foreground">Signed in with {providerLabel(me.authProvider, providers)}</p>
          </div>
        </div>

        {/* Email row — an always-visible Save scoped to just this field. */}
        <div>
          <div className="flex items-end gap-2">
            <label className="flex-1">
              <span className="mb-1.5 block text-sm font-medium">Email</span>
              <input
                type="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setEmailError(null);
                }}
                className="w-full rounded-xl border border-border bg-background/60 px-3 py-2 text-sm focus-ring"
                placeholder="you@example.com"
              />
            </label>
            <button
              type="button"
              onClick={saveEmail}
              disabled={!dirty || save.isPending}
              className={`rounded-xl px-4 py-2 text-sm font-medium transition-all focus-ring disabled:cursor-not-allowed ${
                dirty && !save.isPending
                  ? 'bg-primary text-primary-foreground shadow-glow hover:opacity-90'
                  : 'bg-muted text-muted-foreground disabled:opacity-70'
              }`}
            >
              Save
            </button>
          </div>
          {emailError ? (
            <p className="mt-1.5 text-xs text-destructive">{emailError}</p>
          ) : (
            <p className="mt-1.5 text-xs text-muted-foreground/70">Where notifications are sent.</p>
          )}
        </div>

        {/* Notifications group under a soft hairline. */}
        <div className="border-t border-border/50 pt-5">
          <div className="mb-3 flex items-center gap-2 text-sm text-muted-foreground">
            <BellIcon className="h-4 w-4" />
            <span>Email me when my request is</span>
          </div>
          {notifyDisabled && (
            <p className="mb-3 text-xs text-muted-foreground/70">
              Email notifications aren’t available yet — this needs an email address on your account and an email
              notifier configured by an admin.
            </p>
          )}
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {NOTIFIABLE_TRANSITIONS.map((t) => (
              <label key={t} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={me.notifyOn.includes(t)}
                  disabled={notifyDisabled || save.isPending}
                  onChange={(e) => onToggle(t, e.target.checked)}
                  style={{ accentColor: 'hsl(var(--primary))' }}
                />
                <span className={notifyDisabled ? 'text-muted-foreground/60' : undefined}>
                  {NOTIFY_TRANSITION_LABELS[t]}
                </span>
              </label>
            ))}
          </div>
        </div>
    </div>
  );
}
