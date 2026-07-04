import { useState } from 'react';
import type { RequestDto } from '@shared/schemas/request';
import { DEFAULT_LIMIT } from '@shared/schemas/v1/common';
import { NOTIFIABLE_TRANSITIONS } from '@shared/schemas/user';
import { useMyRequestsPaged, useMe, useUpdateMe } from '../hooks';
import { StatusBadge } from '../components/StatusBadge';
import { EmptyState } from '../components/EmptyState';
import { InboxIcon, HeadphonesIcon, BellIcon } from '../components/icons';
import { requestFailureReason } from '../components/request-failure';
import { QuotaMeter } from '../components/QuotaMeter';
import { PagedListFooter } from '../components/PagedListFooter';
import { nextLimit } from '../components/paging';
import {
  NOTIFY_TRANSITION_LABELS,
  toggleNotifyOn,
  optInDisabled,
  shouldShowNudge,
} from './notify-prefs';

const NUDGE_DISMISSED_KEY = 'notify-nudge-dismissed';

/**
 * Requester-notification opt-in control (issue #50) + one-time discoverability nudge. Reads the
 * caller's own `notifyOn` + `emailNotifyAvailable` from `/api/me`; toggling a transition PATCHes
 * the self-scoped set. When email delivery isn't available (no contact / no usable email notifier)
 * the control renders disabled with an explanation — opt-in storage is permissive, but toggling is
 * pointless until delivery is possible. The nudge points here and dismisses to localStorage.
 */
function NotifyPrefsCard() {
  const { data: me } = useMe();
  const save = useUpdateMe();
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(NUDGE_DISMISSED_KEY) === '1';
    } catch {
      return false;
    }
  });

  if (!me) return null;
  const disabled = optInDisabled(me.emailNotifyAvailable);
  const nudge = shouldShowNudge(me.emailNotifyAvailable, me.notifyOn, dismissed);

  const dismissNudge = () => {
    try {
      localStorage.setItem(NUDGE_DISMISSED_KEY, '1');
    } catch {
      // best-effort; a private-mode localStorage failure just re-shows the nudge next visit
    }
    setDismissed(true);
  };

  const onToggle = (transition: (typeof NOTIFIABLE_TRANSITIONS)[number], enabled: boolean) => {
    save.mutate({ notifyOn: toggleNotifyOn(me.notifyOn, transition, enabled) });
  };

  return (
    <div className="glass-card mb-6 rounded-xl p-4">
      {nudge && (
        <div className="mb-3 flex items-start justify-between gap-3 rounded-lg bg-primary/10 p-3 text-sm">
          <span className="text-muted-foreground">
            Want an email when your request is ready? Turn on notifications below.
          </span>
          <button
            type="button"
            className="shrink-0 text-xs text-muted-foreground/70 hover:text-foreground"
            onClick={dismissNudge}
          >
            Dismiss
          </button>
        </div>
      )}
      <div className="mb-2 flex items-center gap-2">
        <BellIcon className="h-4 w-4 text-muted-foreground" />
        <h2 className="font-medium">Email notifications</h2>
      </div>
      {disabled && (
        <p className="mb-2 text-xs text-muted-foreground/70">
          Email notifications aren’t available yet — this needs an email address on your account and
          an email notifier configured by an admin.
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {NOTIFIABLE_TRANSITIONS.map((t) => (
          <li key={t}>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={me.notifyOn.includes(t)}
                disabled={disabled || save.isPending}
                onChange={(e) => onToggle(t, e.target.checked)}
              />
              <span className={disabled ? 'text-muted-foreground/60' : undefined}>
                {NOTIFY_TRANSITION_LABELS[t]}
              </span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RequestRow({ r }: { r: RequestDto }) {
  const failureReason = requestFailureReason(r);
  return (
    <li className="glass-card flex items-center gap-4 rounded-xl p-3">
      {r.coverUrl ? (
        <img src={r.coverUrl} alt="" className="h-16 w-16 shrink-0 rounded object-cover" />
      ) : (
        <div className="h-16 w-16 shrink-0 rounded bg-muted" />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{r.title}</p>
        {r.author && <p className="truncate text-sm text-muted-foreground">{r.author}</p>}
        {r.narrator && (
          <p className="mt-0.5 flex items-center gap-1.5 text-sm text-muted-foreground">
            <HeadphonesIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
            <span className="truncate">{r.narrator}</span>
          </p>
        )}
        <p className="text-xs text-muted-foreground/70">
          Requested {new Date(r.requestedAt).toLocaleDateString()}
        </p>
        {r.note && (
          <p className="mt-1 text-xs text-muted-foreground">
            <span className="text-muted-foreground/70">{r.status === 'denied' ? 'Reason: ' : 'Note: '}</span>
            {r.note}
          </p>
        )}
        {failureReason && (
          <p className="mt-1 text-xs text-destructive">
            <span className="text-destructive/70">Failed: </span>
            {failureReason}
          </p>
        )}
      </div>
      <StatusBadge status={r.status} />
    </li>
  );
}

export function MyRequestsPage() {
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  const { data, isLoading, error, isFetching } = useMyRequestsPaged(limit);

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">My requests</h1>
        <QuotaMeter />
      </div>
      <NotifyPrefsCard />
      {isLoading && <p className="text-sm text-muted-foreground/70">Loading…</p>}
      {error && <p className="text-sm text-destructive">Could not load your requests.</p>}
      {data && data.data.length === 0 && (
        <EmptyState
          icon={InboxIcon}
          title="No requests yet"
          subtitle="You haven’t requested anything yet — find your next listen and request it."
        />
      )}
      {data && data.data.length > 0 && (
        <>
          <ul className="flex flex-col gap-3">
            {data.data.map((r) => (
              <RequestRow key={r.publicId} r={r} />
            ))}
          </ul>
          <PagedListFooter
            loaded={data.data.length}
            total={data.total}
            limit={limit}
            isFetching={isFetching}
            onLoadMore={() => setLimit(nextLimit)}
          />
        </>
      )}
    </div>
  );
}
