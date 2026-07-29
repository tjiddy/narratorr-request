// The Amazon approved-personal-document-email education (issue #149), defined ONCE and rendered at
// two sites — the account modal's Kindle row (the setup-time teaching moment) and the ebook sheet's
// Send-to-Kindle caption (the reminder). Both go through the shared `KindleAllowlistHelp`
// component, so this module is the single definition of the URL, the link label and the click path.

/**
 * Amazon's Personal Document Settings deep link.
 *
 * BEST-EFFORT, deliberately. Amazon's Manage Your Content and Devices page is a single-page app
 * whose hash anchors drift without notice, and the domain is region-specific (`amazon.co.uk`,
 * `amazon.de`, …) — a `.com` link lands a non-US customer on the wrong storefront. So the link is a
 * convenience, and {@link AMAZON_APPROVED_LIST_STEPS} — the text click path — is the DURABLE
 * documentation: it survives both an anchor change and a region mismatch. Localizing the domain is
 * explicitly out of scope (#149).
 */
export const AMAZON_APPROVED_LIST_URL = 'https://www.amazon.com/hz/mycd/myx#/home/settings/pdoc';

/** The link's visible text. The ↗ is the app's affordance for "opens in a new tab". */
export const AMAZON_APPROVED_LIST_LINK_LABEL = 'Add that address to Amazon’s approved list ↗';

/** The disclosure trigger — collapsed by default at both sites. */
export const AMAZON_APPROVED_LIST_DISCLOSURE_LABEL = 'Where is that?';

/**
 * The full click path, in order. Rendered inside the disclosure panel; the last step is the one
 * that matters (the address to approve is the SENDER mailbox, not the reader's own Kindle address).
 */
export const AMAZON_APPROVED_LIST_STEPS = [
  'Amazon',
  'Account',
  'Content & Devices',
  'Preferences',
  'Personal Document Settings',
  'Approved Personal Document E-mail List',
  '“Add a new approved e-mail address”',
  'Enter the sender mailbox',
] as const;

/** Why this is worth doing once — it is not a per-book or per-send step. */
export const AMAZON_APPROVED_LIST_NOTE = 'One-time setup per Amazon account.';
