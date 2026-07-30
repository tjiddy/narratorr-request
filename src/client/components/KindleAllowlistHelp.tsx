import { Disclosure } from './Disclosure';
import {
  AMAZON_APPROVED_LIST_URL,
  AMAZON_APPROVED_LIST_LINK_LABEL,
  AMAZON_APPROVED_LIST_DISCLOSURE_LABEL,
  AMAZON_APPROVED_LIST_STEPS,
  AMAZON_APPROVED_LIST_NOTE,
} from './kindle-allowlist';

/**
 * The Amazon approved-personal-document-email education (issue #149), rendered at BOTH of its
 * sites from this one component: beside the account modal's Kindle address row (the setup-time
 * teaching moment — a sender Amazon hasn't approved is silently dropped, so this is the step that
 * decides whether sends ever arrive) and under the ebook sheet's Send-to-Kindle caption (the
 * reminder). Two copies would be two chances to drift.
 *
 * ONE collapsed row (UAT de-busying, 2026-07-29): the named sender, the deep link and the click
 * path all live INSIDE the disclosure. The previous shape stacked a sender sentence + a link + a
 * separate expander under the Kindle input — three visible concerns for one field.
 *
 * `target="_blank"` with `rel="noopener noreferrer"` — the `rel` is not optional decoration here:
 * the destination is external and outside our control, and `noopener` is what stops it reaching
 * back through `window.opener`.
 */
export function KindleAllowlistHelp({
  className,
  senderEmail,
}: {
  className?: string | undefined;
  /**
   * The system's From mailbox (`/api/features`' `kindleSenderEmail`), when the caller knows it.
   * Named outright so nobody mistakes the approval target for their own kindle.com address —
   * the UAT misread the earlier copy invited (2026-07-29). Null/omitted = line not rendered
   * (the ebook sheet's caption already names the sender, so it passes nothing).
   */
  senderEmail?: string | null | undefined;
}) {
  return (
    <div className={className}>
      <Disclosure label={AMAZON_APPROVED_LIST_DISCLOSURE_LABEL}>
        <div className="flex flex-col gap-1.5">
          {senderEmail != null && (
            <p className="text-xs text-muted-foreground/80">
              Amazon must allow mail from <strong className="font-mono">{senderEmail}</strong> — your
              Kindle address is where books arrive, not what gets approved.
            </p>
          )}
          <a
            href={AMAZON_APPROVED_LIST_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="w-fit rounded-lg text-xs font-medium text-primary transition-opacity hover:opacity-80 focus-ring"
          >
            {AMAZON_APPROVED_LIST_LINK_LABEL}
          </a>
          <ol className="list-inside list-decimal space-y-0.5 text-xs text-muted-foreground/80">
            {AMAZON_APPROVED_LIST_STEPS.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <p className="text-xs text-muted-foreground/70">{AMAZON_APPROVED_LIST_NOTE}</p>
        </div>
      </Disclosure>
    </div>
  );
}
