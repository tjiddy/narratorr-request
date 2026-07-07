import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { RequestDto } from '@shared/schemas/request';
import { DEFAULT_LIMIT } from '@shared/schemas/v1/common';
import { useMyRequestsPaged } from '../hooks';
import { StatusBadge } from '../components/StatusBadge';
import { EmptyState } from '../components/EmptyState';
import { Button } from '../components/Button';
import { InboxIcon, HeadphonesIcon, SearchIcon } from '../components/icons';
import { requestFailureReason } from '../components/request-failure';
import { QuotaMeter } from '../components/QuotaMeter';
import { PagedListFooter } from '../components/PagedListFooter';
import { nextLimit } from '../components/paging';

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
  const navigate = useNavigate();

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">My requests</h1>
        <QuotaMeter />
      </div>
      {isLoading && <p className="text-sm text-muted-foreground/70">Loading…</p>}
      {error && <p className="text-sm text-destructive">Could not load your requests.</p>}
      {data && data.data.length === 0 && (
        <EmptyState
          icon={InboxIcon}
          title="No requests yet"
          subtitle="You haven’t requested anything yet — find your next listen and request it."
        >
          <Button variant="primary" icon={SearchIcon} className="shadow-glow" onClick={() => void navigate('/')}>
            Browse audiobooks
          </Button>
        </EmptyState>
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
