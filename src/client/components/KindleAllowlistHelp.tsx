import { useEffect, useRef, useState } from 'react';
import { Disclosure } from './Disclosure';
import { CheckIcon, CopyIcon } from './icons';
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
   * the UAT misread the earlier copy invited (2026-07-29). Null/omitted = line not rendered and
   * the final click-path step stays generic (the ebook sheet's caption already names the sender,
   * so it passes nothing).
   */
  senderEmail?: string | null | undefined;
}) {
  // The final step is special-cased: with a known sender it names the mailbox + offers a copy
  // button (UAT 2026-07-31 — don't make the user re-type an address the app knows).
  const priorSteps = AMAZON_APPROVED_LIST_STEPS.slice(0, -1);
  const genericFinalStep = AMAZON_APPROVED_LIST_STEPS[AMAZON_APPROVED_LIST_STEPS.length - 1];
  return (
    <div className={className}>
      <Disclosure label={AMAZON_APPROVED_LIST_DISCLOSURE_LABEL}>
        <div className="flex flex-col gap-1.5">
          {senderEmail != null && (
            // The USER does the allowing — Amazon is just where it happens. "Amazon must allow"
            // read as Amazon holding the pen (UAT 2026-07-31); the trailing colon hands off into
            // the link + click path as one continuous instruction.
            <p className="text-xs text-muted-foreground/80">
              Allow mail from <strong className="font-mono">{senderEmail}</strong> in your Amazon account:
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
            {priorSteps.map((step) => (
              <li key={step}>{step}</li>
            ))}
            <li key={genericFinalStep}>
              {senderEmail != null ? (
                <>
                  Enter <strong className="font-mono">{senderEmail}</strong>{' '}
                  <CopySenderButton address={senderEmail} />
                </>
              ) : (
                genericFinalStep
              )}
            </li>
          </ol>
          <p className="text-xs text-muted-foreground/70">{AMAZON_APPROVED_LIST_NOTE}</p>
        </div>
      </Disclosure>
    </div>
  );
}

/**
 * Copies the sender mailbox to the clipboard with a brief copied-state check. A clipboard failure
 * (denied permission, insecure context) is swallowed — the address is printed right there, so the
 * fallback is the user's own eyes; an error toast for a convenience button would be noise.
 */
function CopySenderButton({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable — nothing to do; the address is visible beside the button.
    }
  };
  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label={copied ? 'Copied' : 'Copy sender address'}
      className="inline-flex translate-y-0.5 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground focus-ring"
    >
      {copied ? <CheckIcon className="h-3.5 w-3.5 text-success" /> : <CopyIcon className="h-3.5 w-3.5" />}
    </button>
  );
}
