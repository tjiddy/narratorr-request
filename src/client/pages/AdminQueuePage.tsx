import { useState } from 'react';
import type { RequestDto, RequestStatus } from '@shared/schemas/request';
import { REQUEST_STATUSES } from '@shared/schemas/request';
import { DEFAULT_LIMIT } from '@shared/schemas/v1/common';
import { useAdminQueue, useDecide } from '../hooks';
import { StatusBadge } from '../components/StatusBadge';
import { REQUEST_STATUS_LABELS } from '../components/status';
import { EmptyState } from '../components/EmptyState';
import { InboxIcon, HeadphonesIcon } from '../components/icons';
import { Button } from '../components/Button';
import { requestFailureReason } from '../components/request-failure';
import { PagedListFooter } from '../components/PagedListFooter';
import { nextLimit } from '../components/paging';

function QueueRow({ r }: { r: RequestDto }) {
  const decide = useDecide();
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState('');
  const failureReason = requestFailureReason(r);

  function confirmDeny() {
    const note = reason.trim();
    // Spread the note only when present — passing `note: undefined` trips
    // exactOptionalPropertyTypes, and an empty reason should stay null.
    decide.mutate({ publicId: r.publicId, action: 'deny', ...(note ? { note } : {}) });
  }

  return (
    <li className="glass-card flex flex-col gap-3 rounded-xl p-3">
      <div className="flex items-center gap-4">
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
            by {r.requester.username} · {new Date(r.requestedAt).toLocaleDateString()}
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
        {r.status === 'pending' && !denying ? (
          <div className="flex shrink-0 gap-2">
            <Button
              variant="success"
              size="sm"
              loading={decide.isPending}
              onClick={() => decide.mutate({ publicId: r.publicId, action: 'approve' })}
            >
              Approve
            </Button>
            <Button variant="secondary" size="sm" disabled={decide.isPending} onClick={() => setDenying(true)}>
              Deny
            </Button>
          </div>
        ) : r.status !== 'pending' ? (
          <StatusBadge status={r.status} />
        ) : null}
      </div>

      {denying && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <input
            autoFocus
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') confirmDeny();
              if (e.key === 'Escape') setDenying(false);
            }}
            maxLength={500}
            placeholder="Reason (optional) — e.g. this is the German edition"
            className="w-full rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <div className="flex shrink-0 gap-2">
            <Button variant="secondary" size="sm" loading={decide.isPending} onClick={confirmDeny}>
              Confirm deny
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={decide.isPending}
              onClick={() => {
                setDenying(false);
                setReason('');
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

export function AdminQueuePage() {
  const [filter, setFilter] = useState<RequestStatus | 'all'>('pending');
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  const { data, isLoading, isFetching, error } = useAdminQueue(filter === 'all' ? undefined : filter, limit);

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <h1 className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">Request queue</h1>
        <select
          value={filter}
          onChange={(e) => {
            // A new filter is a different list — reset the growing-limit back to the first page.
            setFilter(e.target.value as RequestStatus | 'all');
            setLimit(DEFAULT_LIMIT);
          }}
          className="ml-auto rounded-xl border border-border bg-card px-2.5 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
        >
          <option value="all">All</option>
          {REQUEST_STATUSES.map((s) => (
            <option key={s} value={s}>
              {REQUEST_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
      </div>
      {isLoading && <p className="text-sm text-muted-foreground/70">Loading…</p>}
      {error && <p className="text-sm text-destructive">Could not load the request queue.</p>}
      {data && data.data.length === 0 && (
        <EmptyState
          icon={InboxIcon}
          title="Queue empty"
          subtitle={`Nothing here${filter !== 'all' ? ` (${REQUEST_STATUS_LABELS[filter]})` : ''}.`}
        />
      )}
      {data && data.data.length > 0 && (
        <>
          <ul className="flex flex-col gap-3">
            {data.data.map((r) => (
              <QueueRow key={r.publicId} r={r} />
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
