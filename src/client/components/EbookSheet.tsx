import { useId, useState } from 'react';
import { toast } from 'sonner';
import type { V1CompanionEbook } from '@shared/schemas/v1/companion-ebook';
import { isNarratorrBookId } from '@shared/schemas/book-id';
import { useFeatures, useMe, useSendToKindle } from '../hooks';
import { kindleDeliveryVisible } from '../features';
import { Dialog } from './Dialog';
import { Cover } from './Cover';
import { Badge } from './Badge';
import { Button } from './Button';
import { DownloadIcon, SendIcon } from './icons';
import { KindleAllowlistHelp } from './KindleAllowlistHelp';
import { useOpenAccountModal } from './account-modal-seam';
import {
  buildEbookDownloadUrl,
  decideEbookSheetHierarchy,
  downloadErrorCode,
  downloadErrorMessage,
  exceedsBufferBound,
  filenameFromContentDisposition,
  formatEbookSize,
  kindleSendCaption,
  navigateToDownload as defaultNavigate,
  parseContentLength,
  readBoundedBlob,
  saveBlobToDisk,
  FALLBACK_EPUB_FILENAME,
  GENERIC_DOWNLOAD_ERROR,
  KINDLE_ADDRESS_HINT,
  KINDLE_ADDRESS_HINT_ACTION,
  KINDLE_DELIVERY_UNAVAILABLE,
  MAX_BUFFERED_EPUB_BYTES,
  type EbookSheetHierarchy,
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
 * The ONE companion-ebook action sheet (issues #147, #149), hosted by both the search card and the
 * My Requests row. Built on the shared `Dialog`, so focus-in/restore, Esc, overlay-click and the X
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
 *
 * SEND TO KINDLE (#149) is the second leg, and the sheet has exactly ONE amber primary at a time —
 * whichever action this user can actually take. That is `decideEbookSheetHierarchy`'s job; see
 * {@link EbookSheetActions}.
 *
 * `me.kindleEmail` and the feature payload are read LIVE through the hooks below, deliberately NOT
 * snapshotted into {@link EbookSheetTarget} the way the book data is. The download snapshot exists
 * because a polled row can flip its companion to `null` underneath an open sheet; account and
 * operator state have no such hazard, and stale state here would be the wrong kind of wrong — an
 * address saved in another tab should light the sheet up, not wait for a reopen. It is safe
 * BECAUSE the sheet never transmits the address: the server reads `users.kindle_email` itself, so
 * the masked caption is display-only and can never cause a send to a stale destination.
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

  // LIVE account + operator state, through the same `useFeatures(useMe().data)` pairing both hosts
  // already use. The gate is `kindleDeliveryVisible()`, never `.data` — it folds a pending and an
  // errored features query into `false`, which is what makes State C the fail-safe answer.
  const me = useMe().data;
  const features = useFeatures(me);
  const hierarchy = decideEbookSheetHierarchy({
    kindleEmail: me?.kindleEmail ?? null,
    kindleDeliveryVisible: kindleDeliveryVisible(features),
  });

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
    // `scrollBody` for the same reason the account modal needs it (#149): State A renders the same
    // eight-step expandable click path below the cover block, the two actions and the caption, and
    // `Dialog`'s card is `h-fit` inside a FIXED overlay — expanded, it can run past a short
    // viewport's bottom edge with nothing to scroll.
    <Dialog open onClose={onClose} labelledBy={titleId} scrollBody>
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
        <EbookSheetActions
          hierarchy={hierarchy}
          senderEmail={features.data?.kindleSenderEmail ?? null}
          bookId={target.bookId}
          title={target.title}
          downloading={busy}
          onDownload={() => void onDownload()}
          onClose={onClose}
        />
      </div>
    </Dialog>
  );
}

/**
 * The sheet's action block: exactly ONE amber primary, chosen by {@link decideEbookSheetHierarchy}.
 *
 * The two buttons swap POSITION and VARIANT rather than appearing and disappearing, so the sheet's
 * shape is stable across all three states and "Send is unavailable" is something the user can see
 * and read a reason for, rather than an absence they have to infer.
 *
 * The two actions hold INDEPENDENT locks — `downloading` is the caller's, `send.isPending` is this
 * component's. Neither ever gates the other: a send in flight leaves Download usable (it is the
 * fallback for every send failure), and a download in flight leaves Send usable.
 */
function EbookSheetActions({
  hierarchy,
  senderEmail,
  bookId,
  title,
  downloading,
  onDownload,
  onClose,
}: {
  hierarchy: EbookSheetHierarchy;
  senderEmail: string | null;
  bookId: string;
  title: string;
  downloading: boolean;
  onDownload: () => void;
  onClose: () => void;
}) {
  const send = useSendToKindle();
  const openAccount = useOpenAccountModal();
  const sendPrimary = hierarchy.kind === 'send-primary';

  function onSend(): void {
    // Unreachable: both hosts gate the affordance on the same grammar the route enforces. Belt and
    // braces, and it keeps the raw path interpolation in `sendEbookToKindle` honest.
    if (!isNarratorrBookId(bookId)) return;
    send.mutate({ bookId, title });
  }

  // Close the sheet FIRST, then open the account modal: one modal on screen at a time, and the
  // address the user is about to add is exactly what would change this sheet's state anyway.
  function onOpenAccount(): void {
    onClose();
    openAccount?.();
  }

  // KEYED, and load-bearing: the two controls SWAP ORDER when the hierarchy changes under an open
  // sheet (an address saved in another tab, a sender the admin just retired). As positional
  // children React would reconcile them by index and reuse each other's DOM node — the element the
  // user is hovering, or the one holding an in-flight download's pending state, would silently
  // become the other button. Keys make the reorder a move rather than a swap of contents.
  const download = (
    <Button
      key="download"
      variant={sendPrimary ? 'secondary' : 'primary'}
      icon={DownloadIcon}
      loading={downloading}
      onClick={onDownload}
      className={`w-full justify-center${sendPrimary ? '' : ' shadow-glow'}`}
    >
      {downloading ? 'Downloading…' : 'Download eBook'}
    </Button>
  );

  const sendControl = (
    <Button
      key="send"
      variant={sendPrimary ? 'primary' : 'secondary'}
      icon={SendIcon}
      loading={send.isPending}
      disabled={!sendPrimary}
      onClick={onSend}
      className={`w-full justify-center${sendPrimary ? ' shadow-glow' : ''}`}
    >
      {send.isPending ? 'Sending…' : 'Send to Kindle'}
    </Button>
  );

  return (
    <div className="flex flex-col gap-2.5">
      {sendPrimary ? [sendControl, download] : [download, sendControl]}
      {hierarchy.kind === 'send-primary' && (
        <div className="mt-0.5 flex flex-col gap-1.5">
          <p className="text-xs text-muted-foreground/80">
            {kindleSendCaption(hierarchy.kindleEmail, senderEmail)}
          </p>
          <KindleAllowlistHelp />
        </div>
      )}
      {hierarchy.kind === 'address-missing' && (
        <p className="mt-0.5 text-xs text-muted-foreground/80">
          {KINDLE_ADDRESS_HINT}{' '}
          <button
            type="button"
            onClick={onOpenAccount}
            className="rounded font-medium text-primary underline underline-offset-2 transition-opacity hover:opacity-80 focus-ring"
          >
            {KINDLE_ADDRESS_HINT_ACTION}
          </button>
        </p>
      )}
      {/* No account hint here, deliberately: adding an address would not make this instance able to
          send. No sender copy and no allowlist education either — both are meaningless without a
          working sender. */}
      {hierarchy.kind === 'delivery-unavailable' && (
        <p className="mt-0.5 text-xs text-muted-foreground/80">{KINDLE_DELIVERY_UNAVAILABLE}</p>
      )}
    </div>
  );
}
