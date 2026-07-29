import { useId, useState } from 'react';
import { toast } from 'sonner';
import type { V1CompanionEbook } from '@shared/schemas/v1/companion-ebook';
import { Dialog } from './Dialog';
import { Cover } from './Cover';
import { Badge } from './Badge';
import { Button } from './Button';
import { DownloadIcon } from './icons';
import {
  buildEbookDownloadUrl,
  downloadErrorCode,
  downloadErrorMessage,
  exceedsBufferBound,
  filenameFromContentDisposition,
  formatEbookSize,
  navigateToDownload as defaultNavigate,
  parseContentLength,
  readBoundedBlob,
  saveBlobToDisk,
  FALLBACK_EPUB_FILENAME,
  GENERIC_DOWNLOAD_ERROR,
  MAX_BUFFERED_EPUB_BYTES,
  type NavigateToDownload,
  type SaveBlob,
} from './ebook-sheet';

/**
 * Everything the sheet renders and acts on, SNAPSHOT by the host when the trigger is clicked.
 *
 * Snapshotting is load-bearing rather than tidy: My Requests polls every 4s and a companion can
 * validly flip to `null` after a transient lookup failure, so a sheet driven off the live row
 * would unmount itself mid-download. The sheet closes only via its own controls.
 */
export interface EbookSheetTarget {
  bookId: string;
  title: string;
  /** Nullable and CONDITIONAL — there is no "Unknown author" copy. */
  author: string | null;
  series: { name: string; position?: number | null | undefined } | null;
  coverUrl: string | null;
  companion: V1CompanionEbook;
}

/**
 * The ONE companion-ebook action sheet (issue #147), hosted by both the search card and the My
 * Requests row. Built on the shared `Dialog`, so focus-in/restore, Esc, overlay-click and the X
 * button all come for free.
 *
 * It is EBOOK context: no narrator, no duration, no ASIN, no audio publisher (design-review rule).
 *
 * The download is ONE `fetch` of the same-origin proxy, never a probe-then-navigate — that would
 * double narratorr's companion opens and halve the caller's 10-per-minute budget. `fetch` (rather
 * than a plain anchor) is what makes the proxy's stable error codes observable at all: a
 * navigation exposes no status to JS and would either replace the SPA with raw JSON or save that
 * JSON as a junk file. The one place we accept that trade is the over-bound path, where the
 * alternative is buffering an unbounded body.
 */
export function EbookSheet({
  target,
  onClose,
  save = saveBlobToDisk,
  navigate = defaultNavigate,
}: {
  target: EbookSheetTarget;
  onClose: () => void;
  /** Injectable so jsdom — which implements neither `createObjectURL` nor navigation — can stub it. */
  save?: SaveBlob;
  navigate?: NavigateToDownload;
}) {
  const titleId = useId();
  const [busy, setBusy] = useState(false);
  const size = formatEbookSize(target.companion.sizeBytes);
  const url = buildEbookDownloadUrl({ bookId: target.bookId, title: target.title });

  async function onDownload(): Promise<void> {
    // `null` means the affordance should never have been rendered — both hosts gate on the same
    // predicate, so this is unreachable rather than a user-facing state.
    if (url === null) return;

    // EARLY-OUT 1 (pre-fetch): a companion we already know is over the bound never opens a
    // buffered request at all, and never takes the loading lock.
    if (exceedsBufferBound(target.companion.sizeBytes)) {
      navigate(url);
      return;
    }

    const controller = new AbortController();
    setBusy(true);
    try {
      let response: Response;
      try {
        response = await fetch(url, { credentials: 'same-origin', signal: controller.signal });
      } catch {
        toast.error(GENERIC_DOWNLOAD_ERROR);
        return;
      }

      if (!response.ok) {
        toast.error(downloadErrorMessage(await downloadErrorCode(response)));
        return;
      }

      // EARLY-OUT 2 (headers landed): the proxy forwards a parsed upstream length when it has
      // one. An absent, unparseable or lying length changes nothing — the accumulator below is
      // the actual guarantee, which is exactly why it can't live in this check.
      if (exceedsBufferBound(parseContentLength(response.headers.get('content-length')))) {
        controller.abort();
        navigate(url);
        return;
      }

      let body;
      try {
        body = await readBoundedBlob(response, MAX_BUFFERED_EPUB_BYTES);
      } catch {
        // A 200 is not yet a success: the proxy deliberately ERRORS the stream when narratorr
        // dies mid-body, which the browser surfaces as a body read that rejects.
        toast.error(GENERIC_DOWNLOAD_ERROR);
        return;
      }

      if (body.kind === 'over-bound') {
        // OUR abort, of OUR controller — never toasted and never mapped through the error table.
        controller.abort();
        navigate(url);
        return;
      }

      try {
        save(body.blob, filenameFromContentDisposition(response.headers.get('content-disposition')) ?? FALLBACK_EPUB_FILENAME);
      } catch {
        toast.error(GENERIC_DOWNLOAD_ERROR);
      }
    } finally {
      // Always released: a navigate-mode trip hands the transfer to the browser (nothing left to
      // await), and every failure path leaves the sheet open so the user can retry.
      setBusy(false);
    }
  }

  return (
    <Dialog open onClose={onClose} labelledBy={titleId}>
      <div className="flex gap-4 p-5 pr-12">
        <Cover
          url={target.coverUrl}
          title={target.title}
          className="h-24 w-24 shrink-0 rounded-lg object-cover"
          fallbackClassName="flex h-24 w-24 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-muted to-card p-2 text-center text-xs font-medium text-muted-foreground"
        />
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="font-display text-lg font-semibold leading-snug" title={target.title}>
            {target.title}
          </h2>
          {target.author && <p className="truncate text-sm text-muted-foreground">{target.author}</p>}
          {target.series && (
            <p className="flex items-baseline gap-1 text-xs font-medium text-primary/90">
              <span className="min-w-0 truncate">{target.series.name}</span>
              {target.series.position != null && <span className="shrink-0">#{target.series.position}</span>}
            </p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Badge variant="muted">EPUB</Badge>
            {/* No size chip at all for a negative/non-finite `sizeBytes` — never NaN or garbage. */}
            {size !== null && <Badge variant="muted">{size}</Badge>}
          </div>
        </div>
      </div>
      <div className="border-t border-border/60 p-5">
        <Button
          variant="primary"
          icon={DownloadIcon}
          loading={busy}
          onClick={() => void onDownload()}
          className="w-full justify-center shadow-glow"
        >
          {busy ? 'Downloading…' : 'Download eBook'}
        </Button>
      </div>
    </Dialog>
  );
}
