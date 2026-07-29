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
 * `target="_blank"` with `rel="noopener noreferrer"` — the `rel` is not optional decoration here:
 * the destination is external and outside our control, and `noopener` is what stops it reaching
 * back through `window.opener`.
 */
export function KindleAllowlistHelp({ className }: { className?: string | undefined }) {
  return (
    <div className={`flex flex-col gap-1.5${className ? ` ${className}` : ''}`}>
      <a
        href={AMAZON_APPROVED_LIST_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="w-fit rounded-lg text-xs font-medium text-primary transition-opacity hover:opacity-80 focus-ring"
      >
        {AMAZON_APPROVED_LIST_LINK_LABEL}
      </a>
      <Disclosure label={AMAZON_APPROVED_LIST_DISCLOSURE_LABEL}>
        <ol className="list-inside list-decimal space-y-0.5 text-xs text-muted-foreground/80">
          {AMAZON_APPROVED_LIST_STEPS.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <p className="mt-1.5 text-xs text-muted-foreground/70">{AMAZON_APPROVED_LIST_NOTE}</p>
      </Disclosure>
    </div>
  );
}
