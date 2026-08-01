import { useState } from 'react';
import type { V1AudibleResult } from '@shared/schemas/v1/metadata';
import type { V1CompanionEbook } from '@shared/schemas/v1/companion-ebook';
import type { RequestStatus } from '@shared/schemas/request';
import { useRequestBook } from '../hooks';
import { StatusBadge } from './StatusBadge';
import { Badge } from './Badge';
import { Button } from './Button';
import { Cover } from './Cover';
import { BookIcon } from './icons';
import { EbookSheet, type EbookSheetTarget } from './EbookSheet';
import { resolveBookCardState, type EbookAffordance } from './book-card-state';

export function BookCard({
  result,
  requestedStatus,
  ebooksEnabled = false,
}: {
  result: V1AudibleResult;
  requestedStatus?: RequestStatus | undefined;
  /** Always sourced from `ebooksVisible(useFeatures(…))`, never from `.data` directly. */
  ebooksEnabled?: boolean | undefined;
}) {
  const request = useRequestBook();
  // SNAPSHOT taken at click time and held until the sheet's own close: the shared search cache can
  // refresh the `library` annotation underneath an open dialog.
  const [sheet, setSheet] = useState<EbookSheetTarget | null>(null);
  const author = result.authors.map((a) => a.name).join(', ');
  const narrator = result.narrators.map((n) => n.name).join(', ');
  const state = resolveBookCardState(result.library, requestedStatus, ebooksEnabled);
  // Hoisted to a `const` so the discriminant narrowing survives into the click handler's closure.
  const ebook: EbookAffordance = state.kind === 'library' ? state.ebook : { kind: 'none' };

  const openSheet = (bookId: string, companion: V1CompanionEbook) =>
    setSheet({
      bookId,
      title: result.title,
      author: author || null,
      series: result.series ?? null,
      coverUrl: result.cover,
      companion,
    });

  return (
    <div className="glass-card flex flex-col overflow-hidden rounded-xl transition-all hover:-translate-y-0.5 hover:shadow-card-hover">
      <Cover
        url={result.cover}
        title={result.title}
        className="aspect-square w-full object-cover"
        fallbackClassName="flex aspect-square w-full items-center justify-center bg-gradient-to-br from-muted to-card p-3 text-center text-sm font-medium text-muted-foreground"
      />
      <div className="flex flex-1 flex-col gap-1 p-3">
        <h3 className="line-clamp-2 font-medium leading-snug" title={result.title}>
          {result.title}
        </h3>
        {author && <p className="truncate text-sm text-muted-foreground">{author}</p>}
        {narrator && <p className="truncate text-xs text-muted-foreground/70">Narrated by {narrator}</p>}
        {result.series && (
          // Pin the book number so it's never the casualty of truncation — it's the
          // signal that this title is part of a series at all. Only the (often long)
          // series name ellipsizes; the full string is on hover.
          <p
            className="flex items-baseline gap-1 text-xs font-medium text-primary/90"
            title={`${result.series.name}${result.series.position != null ? ` #${result.series.position}` : ''}`}
          >
            <span className="min-w-0 truncate">{result.series.name}</span>
            {result.series.position != null && <span className="shrink-0">#{result.series.position}</span>}
          </p>
        )}
        <div className="mt-auto pt-2">
          {state.kind === 'request-status' ? (
            <StatusBadge status={state.status} />
          ) : state.kind === 'library' ? (
            // A Fragment, deliberately: with the feature off (`ebook.kind === 'none'`) this slot
            // renders the badge and NOTHING else — no chip, no button, and no extra wrapper
            // element. The card is byte-identical to its pre-#147 self.
            <>
              <Badge variant={state.variant}>
                {state.pulse && (
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" aria-hidden />
                )}
                {state.label}
              </Badge>
              {ebook.kind === 'available' && (
                // The card's ONLY action once it's in the library, so it takes the primary slot
                // with the Request button's exact geometry. Green is deliberate: amber = request
                // it, green = it's here.
                <Button
                  variant="success"
                  size="sm"
                  icon={BookIcon}
                  onClick={() => openSheet(ebook.bookId, ebook.companion)}
                  className="mt-2 w-full justify-center shadow-glow-success"
                >
                  Get eBook
                </Button>
              )}
              {ebook.kind === 'absent' && (
                // Non-interactive: the three availability states are explicit, so a user hunting
                // an ebook never has to infer "no companion" from an absence.
                <span className="mt-2 inline-flex items-center rounded-full border border-dashed border-border/70 px-2 py-0.5 text-[10px] font-medium text-muted-foreground/80">
                  No eBook
                </span>
              )}
            </>
          ) : (
            <Button
              variant="primary"
              size="sm"
              loading={request.isPending}
              onClick={() => request.mutate(result)}
              className="w-full justify-center"
            >
              {request.isPending ? 'Requesting…' : 'Request'}
            </Button>
          )}
        </div>
      </div>
      {sheet && <EbookSheet target={sheet} onClose={() => setSheet(null)} />}
    </div>
  );
}
