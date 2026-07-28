/**
 * Companion-EPUB attachment naming (issue #146). Three pure, TOTAL functions: any JavaScript
 * string in, a header-safe `Content-Disposition` out. Nothing here ever reads an upstream header
 * or a filesystem path — the name is synthesized on our side from the caller's own `?title=` and
 * narratorr's opaque book id, which is what keeps a hostile upstream out of the browser's
 * Save-As dialog.
 *
 * Reused verbatim by #148 (send-to-Kindle) for its attachment name, so the input contract is
 * "any string", not "a URL-decoded query value": a lone surrogate can genuinely arrive.
 */

/** Longest stem we keep, measured in Unicode CODE POINTS (never code units). */
export const MAX_STEM_CODE_POINTS = 100;
/** The last-resort stem, used when both the title and the book id sanitize away. */
export const FALLBACK_STEM = 'companion';

/**
 * Drop every unpaired surrogate code unit, keeping only Unicode SCALAR values.
 *
 * A positive rule rather than a list of hazards, and the reason
 * {@link contentDispositionAttachment} can never throw: `encodeURIComponent` raises `URIError`
 * on a lone surrogate, and code-point iteration alone does NOT remove one that was already in
 * the input (`Array.from('Book \ud83d Title').join('')` preserves it and then throws).
 */
function toScalarValues(input: string): string {
  let out = '';
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = input.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += input.slice(i, i + 2);
        i += 1;
      }
      continue; // an unpaired HIGH surrogate is dropped
    }
    if (code >= 0xdc00 && code <= 0xdfff) continue; // an unpaired LOW surrogate is dropped
    out += input[i];
  }
  return out;
}

/** Trim the characters a filename must not start or end with: ASCII spaces and dots. */
const trimSpacesAndDots = (s: string): string => s.replace(/^[ .]+/u, '').replace(/[ .]+$/u, '');

/**
 * A total function from any string to a (possibly EMPTY) filename stem. It appends no suffix —
 * that is {@link epubFilename}'s job, and it happens exactly once, after a stem has been chosen.
 *
 * The step order is load-bearing:
 *   1. keep only Unicode scalar values (see {@link toScalarValues});
 *   2. normalize every `White_Space` code point — tab / CR / LF / VT / FF included — to U+0020.
 *      This precedes control stripping DELIBERATELY: tab, CR and LF live in U+0000–U+001F, so
 *      stripping controls first would delete them outright and `A\tB` would collapse to `AB`
 *      rather than the specified `A B`;
 *   3. strip the REMAINING controls (none of them is whitespace by now);
 *   4. strip `" \ / : * ? < > |` — the reserved set, path separators included;
 *   5. collapse runs of ASCII spaces;
 *   6. trim leading/trailing spaces and dots;
 *   7. truncate to {@link MAX_STEM_CODE_POINTS} CODE POINTS (`Array.from`, never `slice`, which
 *      would split a surrogate pair). Exactly 100 code points therefore survives intact;
 *   8. re-trim — truncation can expose a trailing space or dot that step 6 could not have seen.
 */
export function sanitizeFilenameStem(input: string): string {
  let out = toScalarValues(input);
  out = out.replace(/\p{White_Space}/gu, ' ');
  // eslint-disable-next-line no-control-regex -- stripping the control range IS the rule here
  out = out.replace(/[\u0000-\u001F\u007F]/gu, '');
  out = out.replace(/["\\/:*?<>|]/gu, '');
  out = out.replace(/ {2,}/gu, ' ');
  out = trimSpacesAndDots(out);
  const points = Array.from(out);
  if (points.length > MAX_STEM_CODE_POINTS) out = points.slice(0, MAX_STEM_CODE_POINTS).join('');
  return trimSpacesAndDots(out);
}

/**
 * Choose the stem, THEN add the suffix — in that order, so a title that sanitizes away can never
 * masquerade as the non-empty stem `.epub`. `?title=???` yields `<bookId>.epub`, never `.epub`.
 *
 * `title` is deliberately `unknown`: Fastify's querystring parser yields an ARRAY for a repeated
 * key, and only a `string` is usable (AC34). Anything else is treated as absent.
 */
export function epubFilename(input: { title?: unknown; bookId: string }): string {
  const fromTitle = typeof input.title === 'string' ? sanitizeFilenameStem(input.title) : '';
  const stem = fromTitle || sanitizeFilenameStem(input.bookId) || FALLBACK_STEM;
  return /\.epub$/iu.test(stem) ? stem : `${stem}.epub`;
}

/**
 * RFC 5987 `ext-value` encoding. NOT raw `encodeURIComponent`: ECMAScript leaves
 * `- . ! ~ * ' ( )` unescaped, while RFC 5987's `attr-char` set excludes `' ( ) *`, so the four
 * of them are percent-escaped afterwards. (`*` cannot survive `sanitizeFilenameStem`, but the
 * encoder covers it so the function is correct for any input, #148 included.)
 */
function encodeExtValue(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/gu,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Build the `Content-Disposition` value for a synthesized filename. Total by construction: the
 * input is reduced to scalar values first, so the ext-value encoder can never throw.
 *
 * The ASCII `filename="…"` form replaces every code point outside printable ASCII with `_` (and
 * the two characters that would break the quoted-string, `"` and `\`); `filename*=UTF-8''…` is
 * added only when the name actually contains non-ASCII.
 */
export function contentDispositionAttachment(filename: string): string {
  const name = toScalarValues(filename);
  // Anything outside printable ASCII becomes `_` — which also neutralizes CR/LF, so the header
  // cannot be split even if a caller hands this an unsanitized name.
  const ascii = name.replace(/[^\u0020-\u007E]/gu, '_').replace(/["\\]/gu, '_');
  const asciiName = ascii.trim() === '' ? `${FALLBACK_STEM}.epub` : ascii;
  const header = `attachment; filename="${asciiName}"`;
  const hasNonAscii = Array.from(name).some((c) => (c.codePointAt(0) ?? 0) > 0x7f);
  return hasNonAscii ? `${header}; filename*=UTF-8''${encodeExtValue(name)}` : header;
}
