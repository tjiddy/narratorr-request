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
  isEmailFieldDirty,
  emailFieldPatchValue,
  reconciledEmailFieldDraft,
  KINDLE_EMAIL_HELP,
} from '../pages/notify-prefs';
import { Dialog } from './Dialog';
import { KindleAllowlistHelp } from './KindleAllowlistHelp';
import { BellIcon } from './icons';

/**
 * The account modal (issue #131), opened from the nav username. Bundles the account preferences that
 * used to live on My Requests: the contact email and the Send-to-Kindle device address (#142), each
 * with its own row-scoped Save, plus the requester-notification opt-in checkboxes, above an identity
 * header. Built on the reusable {@link Dialog} primitive. Pure decision logic (dirty-state, patch
 * value, post-save reconcile, provider label) lives in `notify-prefs.ts`.
 *
 * The inner body ({@link AccountModalContent}) only mounts while the dialog is open, so its draft
 * `useState`s initialize fresh from the stored values on every open — no reset effect needed.
 */
export function AccountModal({ me, open, onClose }: { me: MeDto; open: boolean; onClose: () => void }) {
  const headingId = useId();
  return (
    <Dialog open={open} onClose={onClose} labelledBy={headingId}>
      <AccountModalContent me={me} headingId={headingId} />
    </Dialog>
  );
}

/**
 * One labelled email input with an always-visible, row-scoped Save and an inline error slot — the
 * shared shape of the contact-email row and the Kindle-address row (#142). Purely presentational:
 * every decision (dirty state, patch value, post-save reconcile) is the caller's, taken from the
 * pure helpers in `notify-prefs.ts`. The two rows are otherwise pixel-identical, so they share this
 * rather than each carrying a copy — a second copy is where the rows drift apart.
 *
 * `saveLabel` is the button's ACCESSIBLE name (the visible text is just "Save" on both rows): two
 * identically-labelled buttons in one dialog are ambiguous to a screen reader.
 */
function EmailFieldRow({
  label,
  saveLabel,
  placeholder,
  help,
  value,
  onChange,
  onSave,
  dirty,
  pending,
  error,
}: {
  label: string;
  saveLabel: string;
  placeholder: string;
  /** Muted copy under the field, shown whenever there is no error. */
  help: string;
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  dirty: boolean;
  pending: boolean;
  error: string | null;
}) {
  const active = dirty && !pending;
  return (
    <div>
      <div className="flex items-end gap-2">
        <label className="flex-1">
          <span className="mb-1.5 block text-sm font-medium">{label}</span>
          <input
            type="email"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="w-full rounded-xl border border-border bg-background/60 px-3 py-2 text-sm focus-ring"
            placeholder={placeholder}
          />
        </label>
        <button
          type="button"
          onClick={onSave}
          disabled={!active}
          aria-label={saveLabel}
          className={`rounded-xl px-4 py-2 text-sm font-medium transition-all focus-ring disabled:cursor-not-allowed ${
            active
              ? 'bg-primary text-primary-foreground shadow-glow hover:opacity-90'
              : 'bg-muted text-muted-foreground disabled:opacity-70'
          }`}
        >
          Save
        </button>
      </div>
      {error ? (
        <p className="mt-1.5 text-xs text-destructive">{error}</p>
      ) : (
        <p className="mt-1.5 text-xs text-muted-foreground/70">{help}</p>
      )}
    </div>
  );
}

function AccountModalContent({ me, headingId }: { me: MeDto; headingId: string }) {
  // The contact row + the instant-apply notification checkboxes share one mutation instance (their
  // existing coupling, unchanged); the Kindle row gets its OWN (#142 F5). Two independent, row-scoped
  // commit buttons must not gate on each other — a single shared instance would disable a dirty
  // Kindle Save for the duration of an in-flight contact save, and vice versa. Each row also keeps
  // its own error state, so a rejected save surfaces next to the field that caused it.
  const save = useUpdateMe();
  const saveKindle = useUpdateMe();
  const { data: authProviders } = useAuthProviders();

  const [email, setEmail] = useState(me.email ?? '');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [kindleEmail, setKindleEmail] = useState(me.kindleEmail ?? '');
  const [kindleError, setKindleError] = useState<string | null>(null);

  const initial = me.username.charAt(0).toUpperCase() || '?';
  const providers = authProviders?.providers ?? [];
  const dirty = isEmailFieldDirty(me.email, email);
  const kindleDirty = isEmailFieldDirty(me.kindleEmail, kindleEmail);
  const notifyDisabled = optInDisabled(me.emailNotifyAvailable);

  const saveEmail = () => {
    setEmailError(null);
    save.mutate(
      { email: emailFieldPatchValue(email) },
      {
        // Reconcile the draft to the server-normalized contact so a case-normalized save (e.g.
        // New@Contact.COM -> new@contact.com) doesn't leave Save falsely dirty (F2).
        onSuccess: (dto) => setEmail(reconciledEmailFieldDraft(dto.email)),
        onError: (err) => setEmailError(err instanceof ApiError ? err.message : 'Could not save email'),
      },
    );
  };

  // Commits ONLY `kindleEmail` — the contact address is never carried along. An empty field sends
  // `null` (the clear sentinel; `""` would 400), any other value goes trimmed for the server's
  // `kindleEmailSchema` to lowercase + domain-check.
  const saveKindleEmail = () => {
    setKindleError(null);
    saveKindle.mutate(
      { kindleEmail: emailFieldPatchValue(kindleEmail) },
      {
        // Same reconcile as the contact row: adopt the server-normalized value so a mixed-case save
        // (Device@KINDLE.COM -> device@kindle.com) doesn't leave this Save falsely dirty.
        onSuccess: (dto) => setKindleEmail(reconciledEmailFieldDraft(dto.kindleEmail)),
        onError: (err) =>
          setKindleError(err instanceof ApiError ? err.message : 'Could not save Kindle address'),
      },
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

        <EmailFieldRow
          label="Email"
          saveLabel="Save email"
          placeholder="you@example.com"
          help="Where notifications are sent."
          value={email}
          onChange={(v) => {
            setEmail(v);
            setEmailError(null);
          }}
          onSave={saveEmail}
          dirty={dirty}
          pending={save.isPending}
          error={emailError}
        />

        {/* The Kindle row plus its allowlist education (#149). The education is a SIBLING of the
            row, deliberately NOT routed through `help`: that prop renders only while the row's
            inline `error` is null, so education passed through it would vanish exactly when a save
            has just failed — the moment the user most needs it. This is the setup-time teaching
            moment, so it renders whether or not an address is saved yet. */}
        <div className="flex flex-col gap-2">
          <EmailFieldRow
            label="Kindle address"
            saveLabel="Save Kindle address"
            placeholder="you@kindle.com"
            help={KINDLE_EMAIL_HELP}
            value={kindleEmail}
            onChange={(v) => {
              setKindleEmail(v);
              setKindleError(null);
            }}
            onSave={saveKindleEmail}
            dirty={kindleDirty}
            pending={saveKindle.isPending}
            error={kindleError}
          />
          <KindleAllowlistHelp />
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
