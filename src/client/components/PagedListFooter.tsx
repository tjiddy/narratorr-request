import { Button } from './Button';
import { canLoadMore, hasMore } from './paging';

/**
 * Shared footer for the request list views. Renders nothing when the list is fully
 * loaded (`total <= loaded`) — so the common case is visually unchanged — and otherwise
 * surfaces the total count plus a "Load more" control (hidden once growing-limit hits
 * MAX_LIMIT). `isFetching` reflects the in-flight larger-page fetch.
 */
export function PagedListFooter({
  loaded,
  total,
  limit,
  isFetching,
  onLoadMore,
}: {
  loaded: number;
  total: number;
  limit: number;
  isFetching: boolean;
  onLoadMore: () => void;
}) {
  if (!hasMore(loaded, total)) return null;
  return (
    <div className="mt-4 flex flex-col items-center gap-2">
      <p className="text-sm text-muted-foreground/70">
        Showing {loaded} of {total}
      </p>
      {canLoadMore(loaded, total, limit) && (
        <Button variant="secondary" size="sm" loading={isFetching} onClick={onLoadMore}>
          Load more
        </Button>
      )}
    </div>
  );
}
