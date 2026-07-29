import { describe, it, expect } from 'vitest';
import { isNarratorrBookId } from '@shared/schemas/book-id';
import {
  formatEbookSize,
  buildEbookDownloadUrl,
  exceedsBufferBound,
  parseContentLength,
  readBoundedBlob,
  filenameFromContentDisposition,
  downloadErrorMessage,
  downloadErrorCode,
  MAX_BUFFERED_EPUB_BYTES,
  EPUB_MEDIA_TYPE,
  GENERIC_DOWNLOAD_ERROR,
} from './ebook-sheet';

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
