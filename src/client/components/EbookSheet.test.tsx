import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { EbookSheet, type EbookSheetTarget } from './EbookSheet';
import {
  saveBlobToDisk,
  navigateToDownload,
  GENERIC_DOWNLOAD_ERROR,
  MAX_BUFFERED_EPUB_BYTES,
  downloadErrorMessage,
  type NavigateToDownload,
  type SaveBlob,
} from './ebook-sheet';

/**
 * DOM-only coverage for the shared companion-ebook sheet (#147). Every DECISION it composes —
 * size formatting, URL building, the bound predicate, the bounded accumulator, filename parsing
 * and the error-code table — is unit-tested in `ebook-sheet.test.ts`; this file covers what can't
 * be a pure function: the rendered content, the accessible dialog name, and the multi-step
 * download orchestration (loading lock, error toasts, post-OK failures, bound trips).
 *
 * Absence assertions are SYNCHRONOUS `queryBy*` — `vi.waitFor` passes on its first tick and
 * cannot prove a negative.
 */

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const BOOK_ID = 'bk_abc123';

const target = (over: Partial<EbookSheetTarget> = {}): EbookSheetTarget => ({
  bookId: BOOK_ID,
  title: 'The Hobbit',
  author: 'J. R. R. Tolkien',
  series: { name: 'Middle-earth', position: 1 },
  coverUrl: 'https://example.com/cover.jpg',
  companion: { format: 'epub', sizeBytes: 1536 },
  ...over,
});

/** A minimal stand-in for the bits of `Response` the sheet actually reads. */
function response(init: {
  ok?: boolean;
  status?: number;
  headers?: Record<string, string>;
  body?: ReadableStream<Uint8Array> | null;
  json?: () => Promise<unknown>;
}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    headers: { get: (name: string) => init.headers?.[name.toLowerCase()] ?? null },
    body: init.body ?? null,
    json: init.json ?? (() => Promise.resolve({})),
  } as unknown as Response;
}

const bodyOf = (...chunks: Uint8Array[]): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

/** A chunk that REPORTS a huge size without allocating one — the accumulator only reads it. */
const hugeChunk = (bytes: number) => ({ byteLength: bytes }) as unknown as Uint8Array;

const okDownload = (over: { headers?: Record<string, string> } = {}) =>
  response({
    headers: { 'content-disposition': 'attachment; filename="The Hobbit.epub"', ...over.headers },
    body: bodyOf(new Uint8Array([1, 2, 3])),
  });

let save: Mock<SaveBlob>;
let navigate: Mock<NavigateToDownload>;
let onClose: Mock<() => void>;
/** The `RequestInit` of every fetch the sheet made, in order. */
let fetchCalls: [string, RequestInit | undefined][];
let fetchResponder: () => Promise<Response>;

beforeEach(() => {
  save = vi.fn<SaveBlob>();
  navigate = vi.fn<NavigateToDownload>();
  onClose = vi.fn<() => void>();
  fetchCalls = [];
  fetchResponder = () => Promise.resolve(okDownload());
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push([String(input), init]);
      return fetchResponder();
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const renderSheet = (over: Partial<EbookSheetTarget> = {}) =>
  render(<EbookSheet target={target(over)} onClose={onClose} save={save} navigate={navigate} />);

const downloadButton = () => screen.getByRole('button', { name: /download ebook|downloading/i });

describe('EbookSheet — content', () => {
  it('renders cover, title, author, series and the EPUB + size chips', () => {
    renderSheet();

    expect(screen.getByRole('img', { name: 'Cover of The Hobbit' })).toHaveAttribute(
      'src',
      'https://example.com/cover.jpg',
    );
    expect(screen.getByRole('heading', { name: 'The Hobbit' })).toBeInTheDocument();
    expect(screen.getByText('J. R. R. Tolkien')).toBeInTheDocument();
    expect(screen.getByText('Middle-earth')).toBeInTheDocument();
    expect(screen.getByText('#1')).toBeInTheDocument();
    expect(screen.getByText('EPUB')).toBeInTheDocument();
    expect(screen.getByText('1.5 KB')).toBeInTheDocument();
  });

  it('wires labelledBy so the dialog has the book title as its ACCESSIBLE NAME', () => {
    // Asserting the role and the title text separately would still pass with the id unwired.
    renderSheet();
    expect(screen.getByRole('dialog', { name: 'The Hobbit' })).toBeInTheDocument();
  });

  it('shows NO narrator or audio-edition metadata (the sheet is ebook context)', () => {
    renderSheet();
    expect(screen.queryByText(/narrat/i)).toBeNull();
    expect(screen.queryByText(/Rob Inglis/)).toBeNull();
  });

  it.each([
    ['a null author', { author: null }],
    ['an empty author string (an empty `authors` array upstream)', { author: '' }],
  ])('omits the author row entirely for %s — no placeholder copy', (_label, over) => {
    renderSheet(over);
    expect(screen.queryByText(/unknown author/i)).toBeNull();
    expect(screen.queryByText('J. R. R. Tolkien')).toBeNull();
  });

  it('omits the series row when the host has none', () => {
    renderSheet({ series: null });
    expect(screen.queryByText('Middle-earth')).toBeNull();
  });

  it('renders a zero-byte companion as "0 B" and a non-finite one with NO size chip', () => {
    const zero = renderSheet({ companion: { format: 'epub', sizeBytes: 0 } });
    expect(screen.getByText('0 B')).toBeInTheDocument();
    zero.unmount();

    renderSheet({ companion: { format: 'epub', sizeBytes: NaN } });
    expect(screen.getByText('EPUB')).toBeInTheDocument();
    expect(screen.queryByText(/NaN|undefined/)).toBeNull();
  });

  it('falls back to the title tile when the cover image ERRORS', async () => {
    renderSheet();
    const img = screen.getByRole('img', { name: 'Cover of The Hobbit' });

    await userEvent.click(downloadButton()); // no-op for this assertion; keeps act() happy
    img.dispatchEvent(new Event('error'));

    await waitFor(() => expect(screen.queryByRole('img', { name: 'Cover of The Hobbit' })).toBeNull());
    // The title survives as the placeholder tile's own content, beside the heading.
    expect(screen.getAllByText('The Hobbit').length).toBeGreaterThan(1);
  });

  it('renders the placeholder tile when there is NO cover at all', () => {
    renderSheet({ coverUrl: null });
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getAllByText('The Hobbit').length).toBeGreaterThan(1);
  });
});

describe('EbookSheet — the download happy path', () => {
  it('makes exactly ONE same-origin request and hands the assembled blob to the save seam', async () => {
    renderSheet();

    await userEvent.click(downloadButton());

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]![0]).toBe(`/api/ebooks/${BOOK_ID}/download?title=The+Hobbit`);
    expect(fetchCalls[0]![1]?.credentials).toBe('same-origin');
    const [blob, filename] = save.mock.calls[0]!;
    expect(blob).toBeInstanceOf(Blob);
    expect(new Uint8Array(await (blob as Blob).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    // The proxy's synthesized name, not the opaque blob-URL name.
    expect(filename).toBe('The Hobbit.epub');
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('falls back to companion.epub when the response carries no usable filename', async () => {
    fetchResponder = () => Promise.resolve(response({ body: bodyOf(new Uint8Array([9])) }));
    renderSheet();

    await userEvent.click(downloadButton());

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![1]).toBe('companion.epub');
  });

  it('locks the button while a BUFFERED download is in flight, so a double-click can’t burn two', async () => {
    let release!: (value: Response) => void;
    fetchResponder = () => new Promise<Response>((resolve) => (release = resolve));
    renderSheet();

    await userEvent.click(downloadButton());
    await waitFor(() => expect(downloadButton()).toBeDisabled());
    await userEvent.click(downloadButton());
    expect(fetchCalls).toHaveLength(1);

    release(okDownload());
    await waitFor(() => expect(downloadButton()).not.toBeDisabled());
  });
});

describe('EbookSheet — error responses', () => {
  const envelope = (status: number, code: string) => () =>
    Promise.resolve(response({ ok: false, status, json: () => Promise.resolve({ error: { code } }) }));

  it.each([
    [404, 'EBOOK_UNAVAILABLE'],
    [503, 'EBOOK_BUSY'],
    [403, 'EBOOKS_DISABLED'],
    [503, 'NOT_CONFIGURED'],
    [502, 'NARRATORR_UNAVAILABLE'],
    [429, 'RATE_LIMITED'],
  ])('maps the %d %s envelope to its copy, saves nothing and leaves the dialog open', async (status, code) => {
    fetchResponder = envelope(status, code);
    renderSheet();

    await userEvent.click(downloadButton());

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(downloadErrorMessage(code)));
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it.each([
    ['a rejected fetch', () => Promise.reject(new TypeError('network'))],
    [
      'a non-OK response whose body is malformed / non-JSON',
      () => Promise.resolve(response({ ok: false, status: 502, json: () => Promise.reject(new SyntaxError('nope')) })),
    ],
    [
      'a non-OK response with an unmapped code',
      () =>
        Promise.resolve(
          response({ ok: false, status: 500, json: () => Promise.resolve({ error: { code: 'SOMETHING_NEW' } }) }),
        ),
    ],
    [
      'a guard code (an expired session)',
      () =>
        Promise.resolve(
          response({ ok: false, status: 401, json: () => Promise.resolve({ error: { code: 'UNAUTHORIZED' } }) }),
        ),
    ],
  ])('falls back to the generic toast for %s', async (_label, responder) => {
    fetchResponder = responder;
    renderSheet();

    await userEvent.click(downloadButton());

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(GENERIC_DOWNLOAD_ERROR));
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it.each([
    [
      'the body read rejects mid-stream (the proxy erroring a committed stream)',
      () =>
        Promise.resolve(
          response({
            body: new ReadableStream<Uint8Array>({
              pull() {
                throw new Error('upstream died');
              },
            }),
          }),
        ),
    ],
    ['response.body is null', () => Promise.resolve(response({ body: null }))],
  ])('treats a 200 whose %s as a generic failure that resets the loading state', async (_label, responder) => {
    // A 200 is NOT yet a success: nothing is saved, the dialog stays open, and a retry is possible.
    fetchResponder = responder;
    renderSheet();

    await userEvent.click(downloadButton());

    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(toast.error).toHaveBeenCalledWith(GENERIC_DOWNLOAD_ERROR);
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(downloadButton()).not.toBeDisabled();
  });

  it('treats a THROWING save seam the same way — one generic toast, dialog open, retry possible', async () => {
    save.mockImplementation(() => {
      throw new Error('save failed');
    });
    renderSheet();

    await userEvent.click(downloadButton());

    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(toast.error).toHaveBeenCalledWith(GENERIC_DOWNLOAD_ERROR);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(downloadButton()).not.toBeDisabled();
  });
});

describe('EbookSheet — the buffer bound (AC28)', () => {
  it('takes navigate mode with NO fetch at all when the companion is already over the bound', async () => {
    renderSheet({ companion: { format: 'epub', sizeBytes: MAX_BUFFERED_EPUB_BYTES + 1 } });

    await userEvent.click(downloadButton());

    expect(fetchCalls).toHaveLength(0);
    expect(navigate).toHaveBeenCalledWith(`/api/ebooks/${BOOK_ID}/download?title=The+Hobbit`);
    expect(save).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(downloadButton()).not.toBeDisabled();
  });

  it('aborts the fetch and never reads the body when the content-length is over the bound', async () => {
    // A body whose reader is never even acquired is the sharp assertion here — a stream's own
    // `pull` can fire eagerly on construction, which would make a chunk-level spy lie.
    const getReader = vi.fn(() => {
      throw new Error('the body must never be read on this path');
    });
    fetchResponder = () =>
      Promise.resolve(
        response({
          headers: { 'content-length': String(MAX_BUFFERED_EPUB_BYTES + 1) },
          body: { getReader } as unknown as ReadableStream<Uint8Array>,
        }),
      );
    renderSheet();

    await userEvent.click(downloadButton());

    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(getReader).not.toHaveBeenCalled();
    expect(fetchCalls[0]![1]?.signal?.aborted).toBe(true);
    expect(save).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('trips MID-STREAM with no content-length, aborts OUR controller and never toasts', async () => {
    // The accumulator owns the guarantee: an absent length changes nothing. The abort is asserted
    // HERE because the orchestration layer owns the controller (the helper only sees a Response).
    const half = Math.ceil(MAX_BUFFERED_EPUB_BYTES / 2) + 1;
    fetchResponder = () =>
      Promise.resolve(response({ body: bodyOf(hugeChunk(half), hugeChunk(half)) }));
    renderSheet();

    await userEvent.click(downloadButton());

    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(fetchCalls[0]![1]?.signal?.aborted).toBe(true);
    expect(save).not.toHaveBeenCalled();
    // The abort is OURS — it must never be mapped through the error table.
    expect(toast.error).not.toHaveBeenCalled();
    expect(downloadButton()).not.toBeDisabled();
  });
});

describe('EbookSheet — dialog behavior', () => {
  /** A host with a real trigger, so focus restoration has somewhere to go back to. */
  function Host() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Get eBook
        </button>
        {open && <EbookSheet target={target()} onClose={() => setOpen(false)} save={save} navigate={navigate} />}
      </>
    );
  }

  it('closes on Esc and returns focus to the trigger', async () => {
    render(<Host />);
    const trigger = screen.getByRole('button', { name: 'Get eBook' });
    await userEvent.click(trigger);
    expect(screen.getByRole('dialog', { name: 'The Hobbit' })).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(trigger).toHaveFocus();
  });

  it('closes on the X button', async () => {
    render(<Host />);
    await userEvent.click(screen.getByRole('button', { name: 'Get eBook' }));

    await userEvent.click(screen.getByRole('button', { name: 'Close' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('the default save / navigate seams', () => {
  /** Stub the anchor so jsdom never attempts a real navigation. */
  function stubAnchor() {
    const anchor = { href: '', download: '', click: vi.fn() };
    vi.spyOn(document, 'createElement').mockReturnValue(anchor as unknown as HTMLAnchorElement);
    return anchor;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('names the file, clicks the anchor and revokes the object URL', () => {
    const anchor = stubAnchor();
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL: () => 'blob:fake', revokeObjectURL });

    saveBlobToDisk(new Blob(['x']), 'The Hobbit.epub');

    expect(anchor.href).toBe('blob:fake');
    expect(anchor.download).toBe('The Hobbit.epub');
    expect(anchor.click).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake');
  });

  it('revokes the object URL even when the anchor step THROWS', () => {
    // Otherwise a failed save leaks the whole buffered EPUB for the tab's lifetime.
    const anchor = stubAnchor();
    anchor.click.mockImplementation(() => {
      throw new Error('click failed');
    });
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL: () => 'blob:fake', revokeObjectURL });

    expect(() => saveBlobToDisk(new Blob(['x']), 'a.epub')).toThrow('click failed');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake');
  });

  it('navigate mode clicks a download anchor with an EMPTY name, so the proxy header wins', () => {
    const anchor = stubAnchor();

    navigateToDownload('/api/ebooks/bk_1/download?title=Dune');

    expect(anchor.href).toBe('/api/ebooks/bk_1/download?title=Dune');
    expect(anchor.download).toBe('');
    expect(anchor.click).toHaveBeenCalledTimes(1);
  });
});
