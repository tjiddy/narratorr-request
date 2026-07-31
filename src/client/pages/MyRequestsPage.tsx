import { useState } from 'react';
import { useNavigate } from 'react-router';
import type { RequestDto } from '@shared/schemas/request';
import { DEFAULT_LIMIT } from '@shared/schemas/v1/common';
import { isNarratorrBookId } from '@shared/schemas/book-id';
import { useMyRequestsPaged, useMe, useFeatures } from '../hooks';
import { ebooksVisible } from '../features';
import { StatusBadge } from '../components/StatusBadge';
import { EmptyState } from '../components/EmptyState';
import { Button } from '../components/Button';
import { InboxIcon, HeadphonesIcon, SearchIcon, BookIcon } from '../components/icons';
import { requestFailureReason } from '../components/request-failure';
import { QuotaMeter } from '../components/QuotaMeter';
import { PagedListFooter } from '../components/PagedListFooter';
import { nextLimit } from '../components/paging';
import { EbookSheet, type EbookSheetTarget } from '../components/EbookSheet';

/**
 * Exported for focused DOM coverage of the row's own decisions; `MyRequestsPage` is still the
 * component that proves the real feature-source wiring.
 */
export function RequestRow({ r, ebooksEnabled = false }: { r: RequestDto; ebooksEnabled?: boolean }) {
  const failureReason = requestFailureReason(r);
  // SNAPSHOT at click time, held until the sheet's OWN close. The list polls every 4s and a
  // companion can validly go back to `null` after a transient lookup failure — a sheet driven off
  // the live row would then unmount itself mid-download.
  const [sheet, setSheet] = useState<EbookSheetTarget | null>(null);
  // The same no-dead-button gate the search card applies: an id the download route wouldn't admit
  // gets no affordance. No "No eBook" chip here — that is a SEARCH-CARD affordance only; rows stay
  // quiet for every other status.
  const bookId = r.narratorrBookId;
  const companion =
    ebooksEnabled && r.status === 'available' && r.companionEbook !== null && bookId !== null && isNarratorrBookId(bookId)
      ? { bookId, companion: r.companionEbook }
      : null;

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
      <div className="flex shrink-0 items-center gap-2">
        <StatusBadge status={r.status} />
        {companion && (
          <Button
            variant="success"
            size="sm"
            icon={BookIcon}
            onClick={() =>
              setSheet({
                bookId: companion.bookId,
                title: r.title,
                author: r.author,
                series: null,
                coverUrl: r.coverUrl,
                companion: companion.companion,
              })
            }
            className="shadow-glow-success"
          >
            Get eBook
          </Button>
        )}
      </div>
      {sheet && <EbookSheet target={sheet} onClose={() => setSheet(null)} />}
    </li>
  );
}

export function MyRequestsPage() {
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  const { data, isLoading, error, isFetching } = useMyRequestsPaged(limit);
  // Through the pure gate, never off `.data` — loading and errored both render the feature as off.
  const ebooksEnabled = ebooksVisible(useFeatures(useMe().data));
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
              <RequestRow key={r.publicId} r={r} ebooksEnabled={ebooksEnabled} />
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
