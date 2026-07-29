import { describe, it, expect } from 'vitest';
import { isNarratorrBookId } from '@shared/schemas/book-id';
import { EBOOK_SEND_OUTCOMES } from '@shared/schemas/ebooks';
import {
  formatEbookSize,
  buildEbookDownloadUrl,
  exceedsBufferBound,
  parseContentLength,
  readBoundedBlob,
  filenameFromContentDisposition,
  downloadErrorMessage,
  downloadErrorCode,
  decideEbookSheetHierarchy,
  maskKindleAddress,
  kindleSendCaption,
  sendOutcomeMessage,
  sendErrorMessage,
  MAX_BUFFERED_EPUB_BYTES,
  EPUB_MEDIA_TYPE,
  GENERIC_DOWNLOAD_ERROR,
  GENERIC_SEND_ERROR,
} from './ebook-sheet';
import {
  AMAZON_APPROVED_LIST_URL,
  AMAZON_APPROVED_LIST_LINK_LABEL,
  AMAZON_APPROVED_LIST_STEPS,
  AMAZON_APPROVED_LIST_NOTE,
} from './kindle-allowlist';

// Pure decision logic for the companion-ebook sheet (issue #147), in the NODE project. The two
// DOM-touching seams from the same module — the default save/navigate anchors — are covered in
// `EbookSheet.test.tsx` under the jsdom project, since they need a `document`.

describe('formatEbookSize', () => {
  it.each([
    [0, '0 B'],
    [1, '1 B'],
    [1023, '1023 B'],
    // One decimal above 1 KB — the SHARED core with `formatDatabaseSize`, whose existing
    // receipts pin exactly this shape ("5.0 MB"), so the two surfaces can't drift.
    [1024, '1.0 KB'],
    [1536, '1.5 KB'],
    [1024 * 1024, '1.0 MB'],
    // 1048566 B is 1023.99… KB, which rounds ACROSS the unit boundary at one decimal.
    [1024 * 1024 - 10, '1024.0 KB'],
    [3 * 1024 * 1024 * 1024, '3.0 GB'],
  ])('formats %d as %s', (input, expected) => {
    expect(formatEbookSize(input)).toBe(expected);
  });

  it('renders a legitimate zero-byte companion as "0 B", never blank or "unknown"', () => {
    // narratorr's guard is `!= null`, not truthiness — `sizeBytes: 0` round-trips on purpose.
    expect(formatEbookSize(0)).toBe('0 B');
  });

  it('rounds the positive fractions the contract admits', () => {
    expect(formatEbookSize(0.4)).toBe('0 B');
    expect(formatEbookSize(0.5)).toBe('1 B');
  });

  it.each([-1, -0.4, -0.5, NaN, Infinity, -Infinity])('returns null for %p (no size chip)', (input) => {
    // -0.4 and -0.5 are the STEP-ORDER guard: `Math.round(-0.4)` is `-0` and `-0 < 0` is false,
    // so a round-then-validate implementation renders "0 B" for both.
    expect(formatEbookSize(input)).toBeNull();
  });
});

describe('buildEbookDownloadUrl', () => {
  const ID = 'bk_abc123';

  it('builds the same-origin proxy path with a single encoded title param', () => {
    expect(buildEbookDownloadUrl({ bookId: ID, title: 'Dune' })).toBe('/api/ebooks/bk_abc123/download?title=Dune');
  });

  it.each([
    ['ampersands and questions', 'A & B? #1'],
    ['non-ASCII', 'Sœurs à Paris'],
    ['an emoji', 'Book 📚 Two'],
  ])('percent-encodes %s into exactly one title key', (_label, title) => {
    const url = buildEbookDownloadUrl({ bookId: ID, title })!;
    expect(url.split('?')).toHaveLength(2);
    const params = new URLSearchParams(url.split('?')[1]);
    expect([...params.keys()]).toEqual(['title']);
    expect(params.get('title')).toBe(title);
  });

  it.each(['', '   ', '\t\n'])('omits the query entirely for the whitespace title %p', (title) => {
    expect(buildEbookDownloadUrl({ bookId: ID, title })).toBe('/api/ebooks/bk_abc123/download');
  });

  it('never throws on a lone surrogate in the title (the encodeURIComponent hazard)', () => {
    for (const title of ['Book \ud83d Title', 'Book \udc4d Title']) {
      const url = buildEbookDownloadUrl({ bookId: ID, title });
      expect(url).toMatch(/^\/api\/ebooks\/bk_abc123\/download\?title=/);
    }
  });

  it('passes a real base64url id through unescaped', () => {
    const id = 'bk_a-b_cD9';
    expect(buildEbookDownloadUrl({ bookId: id, title: 't' })).toBe(`/api/ebooks/${id}/download?title=t`);
  });

  it.each([
    ['a path separator', 'bk_a/b'],
    ['a query char', 'bk_a?b'],
    ['a fragment char', 'bk_a#b'],
    ['a percent', 'bk_a%2Fb'],
    ['traversal', 'bk_..'],
    ['a lone surrogate', 'bk_\ud83d'],
    ['an empty string', ''],
    ['a bare prefix', 'bk_'],
    ['a foreign prefix', 'xx_1'],
  ])('returns null for %s (%p) — no dead button can be built', (_label, bookId) => {
    expect(buildEbookDownloadUrl({ bookId, title: 't' })).toBeNull();
  });
});

describe('isNarratorrBookId — the shared admission gate (AC26)', () => {
  const idOf = (length: number) => `bk_${'a'.repeat(length - 3)}`;

  it('admits a 64-character id and refuses a 65-character one', () => {
    expect(idOf(64)).toHaveLength(64);
    expect(isNarratorrBookId(idOf(64))).toBe(true);
    expect(isNarratorrBookId(idOf(65))).toBe(false);
  });

  it('refuses the lengths Fastify’s maxParamLength would silently 404', () => {
    // The gate is what makes "renders an affordance" and "reaches the handler" one set: a
    // `prefixedId('bk')`-only check is unbounded, so a 100/101-character id would render a
    // button the router then refuses before the handler ever runs.
    expect(isNarratorrBookId(idOf(100))).toBe(false);
    expect(isNarratorrBookId(idOf(101))).toBe(false);
  });
});

describe('exceedsBufferBound / parseContentLength', () => {
  it('is false exactly AT the bound and true one byte over', () => {
    expect(exceedsBufferBound(MAX_BUFFERED_EPUB_BYTES)).toBe(false);
    expect(exceedsBufferBound(MAX_BUFFERED_EPUB_BYTES + 1)).toBe(true);
  });

  it.each([0, -1, NaN, Infinity, null])('is false for %p — not evidence of anything', (input) => {
    expect(exceedsBufferBound(input)).toBe(false);
  });

  it.each([
    ['123', 123],
    ['0', 0],
    [null, null],
    ['', null],
    ['not-a-number', null],
  ])('parses the content-length header %p as %p', (header, expected) => {
    expect(parseContentLength(header)).toBe(expected);
  });
});

/** A minimal stand-in for the bits of `Response` that `readBoundedBlob` reads. */
function streamResponse(chunks: Uint8Array[], opts: { failAfter?: number } = {}): Response {
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (opts.failAfter !== undefined && i === opts.failAfter) throw new Error('upstream died mid-body');
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[i]!);
      i += 1;
    },
  });
  return { body } as unknown as Response;
}

describe('readBoundedBlob', () => {
  const chunk = (...bytes: number[]) => new Uint8Array(bytes);

  it('assembles a body under the limit into an EPUB blob of exactly the concatenated bytes', async () => {
    const result = await readBoundedBlob(streamResponse([chunk(1, 2), chunk(3)]), 10);

    expect(result.kind).toBe('blob');
    if (result.kind !== 'blob') return;
    expect(result.blob.type).toBe(EPUB_MEDIA_TYPE);
    expect(new Uint8Array(await result.blob.arrayBuffer())).toEqual(chunk(1, 2, 3));
  });

  it('succeeds on a body EXACTLY at the limit (a boundary, not an off-by-one)', async () => {
    const result = await readBoundedBlob(streamResponse([chunk(1, 2), chunk(3)]), 3);
    expect(result.kind).toBe('blob');
  });

  it('returns the over-bound sentinel and cancels the reader when the SECOND chunk crosses', async () => {
    // The fetch abort is deliberately NOT asserted here: the controller belongs to the caller.
    const cancelled: unknown[] = [];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk(1, 2));
        controller.enqueue(chunk(3, 4));
      },
      cancel(reason) {
        cancelled.push(reason ?? null);
      },
    });

    const result = await readBoundedBlob({ body } as unknown as Response, 3);

    expect(result).toEqual({ kind: 'over-bound' });
    expect(cancelled).toHaveLength(1);
  });

  it('trips on an over-limit body even with NO content-length — the bound never reads a header', async () => {
    const noHeaders = { body: streamResponse([chunk(1, 2, 3, 4)]).body } as unknown as Response;
    expect(await readBoundedBlob(noHeaders, 2)).toEqual({ kind: 'over-bound' });
  });

  it('rejects when the reader fails mid-stream (a 200 is not yet a success)', async () => {
    await expect(readBoundedBlob(streamResponse([chunk(1), chunk(2)], { failAfter: 1 }), 100)).rejects.toThrow();
  });

  it('rejects when response.body is null', async () => {
    await expect(readBoundedBlob({ body: null } as unknown as Response, 100)).rejects.toThrow();
  });
});

describe('filenameFromContentDisposition', () => {
  it('reads the server’s ASCII-only output', () => {
    expect(filenameFromContentDisposition('attachment; filename="The Hobbit.epub"')).toBe('The Hobbit.epub');
  });

  it('prefers the decoded filename* when the server emits both', () => {
    const header = `attachment; filename="Soeurs.epub"; filename*=UTF-8''S%C5%93urs.epub`;
    expect(filenameFromContentDisposition(header)).toBe('Sœurs.epub');
  });

  it('falls back to the quoted form when filename* has an invalid percent sequence', () => {
    const header = `attachment; filename="Safe.epub"; filename*=UTF-8''%E0%A4%A`;
    expect(filenameFromContentDisposition(header)).toBe('Safe.epub');
  });

  it('unescapes an escaped quote inside the quoted form', () => {
    expect(filenameFromContentDisposition('attachment; filename="A \\"quoted\\" name.epub"')).toBe(
      'A "quoted" name.epub',
    );
  });

  it('unescapes an escaped BACKSLASH, then reduces past it to the basename', () => {
    // Unescaping runs first (so the pair is one literal `\`), and the basename rule then drops
    // everything up to it — a path separator can never reach `anchor.download`.
    expect(filenameFromContentDisposition('attachment; filename="dir\\\\name.epub"')).toBe('name.epub');
  });

  it.each([
    ['attachment; filename="/etc/passwd.epub"', 'passwd.epub'],
    ['attachment; filename="..\\\\..\\\\win.epub"', 'win.epub'],
    [`attachment; filename*=UTF-8''%2Fetc%2Fpasswd.epub`, 'passwd.epub'],
  ])('reduces %s to its basename', (header, expected) => {
    expect(filenameFromContentDisposition(header)).toBe(expected);
  });

  it.each([null, '', 'attachment', 'inline; nonsense'])('returns null for %p', (header) => {
    expect(filenameFromContentDisposition(header)).toBeNull();
  });
});

describe('downloadErrorMessage', () => {
  it.each(['EBOOK_UNAVAILABLE', 'EBOOK_BUSY', 'EBOOKS_DISABLED', 'NOT_CONFIGURED', 'NARRATORR_UNAVAILABLE', 'RATE_LIMITED'])(
    'maps the action-domain code %s to bespoke copy',
    (code) => {
      const message = downloadErrorMessage(code);
      expect(message).not.toBe(GENERIC_DOWNLOAD_ERROR);
      expect(message.length).toBeGreaterThan(0);
    },
  );

  it('gives every action-domain code DISTINCT copy', () => {
    const codes = ['EBOOK_UNAVAILABLE', 'EBOOK_BUSY', 'EBOOKS_DISABLED', 'NOT_CONFIGURED', 'NARRATORR_UNAVAILABLE', 'RATE_LIMITED'];
    expect(new Set(codes.map(downloadErrorMessage)).size).toBe(codes.length);
  });

  it('retry-flavors the busy code (the route sets retry-after: 5)', () => {
    expect(downloadErrorMessage('EBOOK_BUSY')).toMatch(/try again/i);
  });

  it.each(['UNAUTHORIZED', 'ACCOUNT_PENDING', 'ACCOUNT_REJECTED', 'SOMETHING_NEW', ''])(
    'falls back to the generic message for %p',
    (code) => {
      // The guard codes get NO bespoke copy on purpose — the app's /api/me gate owns sign-in.
      expect(downloadErrorMessage(code)).toBe(GENERIC_DOWNLOAD_ERROR);
    },
  );
});

describe('downloadErrorCode', () => {
  const jsonResponse = (payload: unknown): Response =>
    ({ json: () => Promise.resolve(payload) }) as unknown as Response;

  it('reads the envelope code', async () => {
    expect(await downloadErrorCode(jsonResponse({ error: { code: 'EBOOK_BUSY' } }))).toBe('EBOOK_BUSY');
  });

  it.each([
    ['a missing error object', jsonResponse({})],
    ['a non-string code', jsonResponse({ error: { code: 7 } })],
    ['a null body', jsonResponse(null)],
    ['a rejected json read (non-JSON body)', { json: () => Promise.reject(new SyntaxError('nope')) } as unknown as Response],
  ])('returns the empty code for %s', async (_label, response) => {
    expect(await downloadErrorCode(response)).toBe('');
  });
});

// --- Send to Kindle (issue #149) ---------------------------------------------

describe('decideEbookSheetHierarchy', () => {
  // The one decision behind the sheet's "exactly one amber primary" rule. Total over every
  // (kindleDeliveryVisible × kindleEmail) pair — the component renders only what this returns.
  it.each([
    ['a real address', 'todd@kindle.com'],
    ['an address the user typed with padding', '  todd@kindle.com  '],
  ])('is State A (Send primary) for a visible feature and %s', (_label, kindleEmail) => {
    expect(decideEbookSheetHierarchy({ kindleEmail, kindleDeliveryVisible: true })).toEqual({
      kind: 'send-primary',
      // Trimmed, so the masked caption never renders the user's stray whitespace.
      kindleEmail: 'todd@kindle.com',
    });
  });

  it.each([
    ['null', null],
    ['the empty string', ''],
    // Pinned explicitly: whitespace is NOT an address. A truthiness check would call this State A
    // and render a masked caption for a value the server would never send to.
    ['a whitespace-only string', '   '],
    ['a tab/newline-only string', '\t\n'],
  ])('is State B (address missing) for a visible feature and %s', (_label, kindleEmail) => {
    expect(decideEbookSheetHierarchy({ kindleEmail, kindleDeliveryVisible: true })).toEqual({
      kind: 'address-missing',
    });
  });

  it.each([
    ['a real address', 'todd@kindle.com'],
    ['null', null],
    ['the empty string', ''],
    ['a whitespace-only string', '   '],
  ])('is State C (delivery unavailable) whenever the feature is not visible — even with %s', (_label, kindleEmail) => {
    // `kindleDeliveryVisible` already folds pending and errored into `false`, so State C covers
    // "no usable sender", "still loading" and "the features query blew up" with one branch.
    expect(decideEbookSheetHierarchy({ kindleEmail, kindleDeliveryVisible: false })).toEqual({
      kind: 'delivery-unavailable',
    });
  });
});

describe('maskKindleAddress', () => {
  /** Everything before the FIRST `@` — the portion the mask is allowed to disclose one code point of. */
  const preAt = (value: string): string => {
    const at = value.indexOf('@');
    return at < 0 ? value : value.slice(0, at);
  };

  /**
   * AC7's privacy bound for the malformed inputs: at most the FIRST code point of the pre-`@`
   * portion may appear in the output's own pre-`@` portion. Asserting "the whole local part is not
   * a substring" is too weak — `to…` would pass it while disclosing two characters.
   */
  const expectAtMostFirstCodePoint = (input: string, output: string): void => {
    const source = [...preAt(input)];
    const disclosed = [...preAt(output)].filter((c) => c !== '…');
    expect(disclosed.length).toBeLessThanOrEqual(1);
    if (disclosed.length === 1) expect(disclosed[0]).toBe(source[0]);
    // Scoped to the output's OWN pre-`@` portion: a malformed value's trailing remainder is echoed
    // verbatim (it is not a local part), and it may legitimately share characters with the local
    // part — `todd@evil@kindle.com` keeps an `o` in `.com`. The bound is about what the mask
    // DISCLOSES of the local part, which is exactly the portion checked here.
    for (const rest of source.slice(1)) expect(preAt(output)).not.toContain(rest);
  };

  it('keeps the first and last code point of the local part and the whole domain', () => {
    expect(maskKindleAddress('todd@kindle.com')).toBe('t…d@kindle.com');
  });

  it.each([
    ['a 2-character local part', 'to@kindle.com', 't…@kindle.com'],
    ['a 1-character local part', 't@kindle.com', 't…@kindle.com'],
  ])('never echoes a whole local part — %s masks to first + ellipsis', (_label, input, expected) => {
    expect(maskKindleAddress(input)).toBe(expected);
  });

  it.each([
    ['no @ at all', 'toddkindle', 't…'],
    ['an empty local part', '@kindle.com', '…@kindle.com'],
    ['an empty domain', 'todd@', 't…@'],
    ['a bare @', '@', '…@'],
    ['the empty string', '', '…'],
    ['whitespace only', '   ', '…'],
    ['a second @', 'todd@evil@kindle.com', 't…@evil@kindle.com'],
  ])('stays TOTAL and discloses at most the first code point for %s', (_label, input, expected) => {
    const output = maskKindleAddress(input);
    expect(typeof output).toBe('string');
    expect(output).toBe(expected);
    expectAtMostFirstCodePoint(input, output);
  });

  it('takes the first/last CODE POINT, never a UTF-16 unit, so a surrogate pair stays intact', () => {
    // Slicing by index would split 😀 into two lone surrogates and render mojibake.
    const output = maskKindleAddress('😀ab😀@kindle.com');
    expect(output).toBe('😀…😀@kindle.com');
    // The pair survived as ONE code point, and no replacement character was produced.
    expect([...output][0]).toBe('😀');
    expect(output).not.toContain('�');
    expect(output).not.toContain('ab');
  });

  it.each(['todd@kindle.com', 'a.long.local.part@kindle.com', '😀ab😀@kindle.com'])(
    'never contains the original local part of %p',
    (input) => {
      const local = preAt(input);
      const output = maskKindleAddress(input);
      expect(typeof output).toBe('string');
      expect([...local].length).toBeGreaterThan(2);
      expect(output).not.toContain(local);
      expect(output).not.toContain(input);
    },
  );
});

describe('kindleSendCaption', () => {
  it('names the masked recipient and the sender', () => {
    expect(kindleSendCaption('todd@kindle.com', 'library@example.com')).toBe(
      'Sends to t…d@kindle.com · arrives from library@example.com',
    );
  });

  it.each([
    ['null', null],
    ['an empty sender string', ''],
  ])('OMITS the whole "arrives from" clause for %s — never renders the word null', (_label, sender) => {
    const caption = kindleSendCaption('todd@kindle.com', sender);
    expect(caption).toBe('Sends to t…d@kindle.com');
    expect(caption).not.toMatch(/arrives from/);
    expect(caption).not.toMatch(/null|undefined/);
  });
});

describe('sendOutcomeMessage', () => {
  it('gives every one of the nine contract outcomes non-empty copy', () => {
    // Driven off the SHARED union, so a member added server-side fails here rather than shipping
    // with a missing toast.
    for (const outcome of EBOOK_SEND_OUTCOMES) {
      expect(sendOutcomeMessage(outcome).length).toBeGreaterThan(0);
    }
  });

  it('gives every outcome DISTINCT copy (no copy-paste)', () => {
    expect(new Set(EBOOK_SEND_OUTCOMES.map(sendOutcomeMessage)).size).toBe(EBOOK_SEND_OUTCOMES.length);
  });

  // Independent literal pins (#149 F10): the component cases import the same table production does,
  // so wrong text there would update both sides and stay green. These two carry the load-bearing
  // honesty — "we handed it to Amazon" vs. "we could not confirm anything".
  it('pins the exact success copy', () => {
    expect(sendOutcomeMessage('sent')).toBe('Sent to Amazon — conversion and delivery happen on Amazon’s side.');
  });

  it('pins the exact indeterminate copy, including the do-not-resend instruction', () => {
    expect(sendOutcomeMessage('indeterminate')).toBe(
      'We couldn’t confirm the handoff. Don’t resend immediately — check your Kindle library first.',
    );
  });

  it.each([
    ['rate_limited' as const, /too quickly|wait/i],
    ['quota_exhausted' as const, /allowance/i],
    ['too_large' as const, /too large/i],
  ])('makes %s actionable', (outcome, pattern) => {
    expect(sendOutcomeMessage(outcome)).toMatch(pattern);
  });
});

describe('sendErrorMessage', () => {
  it.each(['EBOOKS_DISABLED', 'EBOOK_UNAVAILABLE', 'BAD_REQUEST', 'INTERNAL'])(
    'gives %s its own bespoke copy',
    (code) => {
      const message = sendErrorMessage(code);
      expect(message).not.toBe(GENERIC_SEND_ERROR);
      expect(message.length).toBeGreaterThan(0);
    },
  );

  it('gives the four bespoke codes DISTINCT copy', () => {
    const codes = ['EBOOKS_DISABLED', 'EBOOK_UNAVAILABLE', 'BAD_REQUEST', 'INTERNAL'];
    expect(new Set(codes.map(sendErrorMessage)).size).toBe(codes.length);
  });

  it.each([
    // The parser's other two answers. Effectively unreachable from our own client (a tiny JSON body
    // sent as application/json) but they ARE codes this route can emit — a table written as an
    // exhaustive switch over the four bespoke codes would return `undefined` here.
    'PAYLOAD_TOO_LARGE',
    'UNSUPPORTED_MEDIA_TYPE',
    // A rejected fetch / a malformed body / an unknown code.
    'NON_JSON',
    'SOMETHING_NEW',
    '',
    // Guard codes get NO bespoke copy — the app's /api/me gate owns the sign-in experience.
    'UNAUTHORIZED',
    'ACCOUNT_PENDING',
    'ACCOUNT_REJECTED',
  ])('falls back to the single generic message for %p', (code) => {
    expect(sendErrorMessage(code)).toBe(GENERIC_SEND_ERROR);
  });
});

describe('the Amazon allowlist constants (one definition, two render sites)', () => {
  it('pins the deep link literal', () => {
    expect(AMAZON_APPROVED_LIST_URL).toBe('https://www.amazon.com/hz/mycd/myx#/home/settings/pdoc');
  });

  it('pins the exact link label', () => {
    expect(AMAZON_APPROVED_LIST_LINK_LABEL).toBe('Add that address to Amazon’s approved list ↗');
  });

  it.each([
    'Amazon',
    'Account',
    'Content & Devices',
    'Preferences',
    'Personal Document Settings',
    'Approved Personal Document E-mail List',
    '“Add a new approved e-mail address”',
    'Enter the sender mailbox',
  ])('carries the click-path step %p, in order', (step) => {
    expect(AMAZON_APPROVED_LIST_STEPS).toContain(step);
  });

  it('lists the steps in the click order Amazon actually presents', () => {
    expect([...AMAZON_APPROVED_LIST_STEPS]).toEqual([
      'Amazon',
      'Account',
      'Content & Devices',
      'Preferences',
      'Personal Document Settings',
      'Approved Personal Document E-mail List',
      '“Add a new approved e-mail address”',
      'Enter the sender mailbox',
    ]);
  });

  it('records that this is one-time setup per Amazon account', () => {
    expect(AMAZON_APPROVED_LIST_NOTE).toMatch(/one-time/i);
    expect(AMAZON_APPROVED_LIST_NOTE).toMatch(/Amazon account/i);
  });
});
