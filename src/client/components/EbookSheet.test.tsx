import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { useState } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { MeDto } from '@shared/schemas/user';
import type { FeaturesDto } from '@shared/schemas/features';
import { EBOOK_SEND_OUTCOMES } from '@shared/schemas/ebooks';
import { qk } from '../hooks';
import { OpenAccountModalContext } from './account-modal-seam';
import { EbookSheet, type EbookSheetTarget } from './EbookSheet';
import {
  saveBlobToDisk,
  navigateToDownload,
  GENERIC_DOWNLOAD_ERROR,
  GENERIC_SEND_ERROR,
  MAX_BUFFERED_EPUB_BYTES,
  KINDLE_ADDRESS_HINT_ACTION,
  KINDLE_DELIVERY_UNAVAILABLE,
  downloadErrorMessage,
  sendErrorMessage,
  sendOutcomeMessage,
  SENT_CONFIRMATION_DETAIL,
  SENT_CONFIRMATION_HEADLINE,
  type NavigateToDownload,
  type SaveBlob,
} from './ebook-sheet';
import {
  AMAZON_APPROVED_LIST_URL,
  AMAZON_APPROVED_LIST_LINK_LABEL,
  AMAZON_APPROVED_LIST_DISCLOSURE_LABEL,
} from './kindle-allowlist';

/**
 * DOM-only coverage for the shared companion-ebook sheet (#147, #149). Every DECISION it composes —
 * size formatting, URL building, the bound predicate, the bounded accumulator, filename parsing,
 * the hierarchy decision, address masking and all three copy tables — is unit-tested in
 * `ebook-sheet.test.ts`; this file covers what can't be a pure function: the rendered content, the
 * accessible dialog name, the download orchestration (loading lock, error toasts, post-OK
 * failures, bound trips) and the Send leg's hierarchy rendering, disclosure, pending isolation and
 * toast orchestration.
 *
 * The sheet reads `me.kindleEmail` and the feature payload LIVE (#149 AC5/AC6), so this harness
 * carries a real `QueryClient` and a `fetch` stub routing `/api/me` + `/api/features` — the
 * pattern `SearchPage.test.tsx`'s page-level harness established. The default is STATE A (an
 * address saved, delivery available), so the download cases keep exercising an enabled Download.
 *
 * Absence assertions are SYNCHRONOUS `queryBy*` — `vi.waitFor` passes on its first tick and
 * cannot prove a negative — and they run only AFTER the features query is proven terminal
 * (synchronize-dependent-query-before-absence-assert): `kindleDeliveryVisible()` returns false for
 * pending as well as for a real "off", so an unsynchronized absence assertion passes whether or not
 * the gate works. Everything the sheet renders is portaled into `<body>`, so absences are queried
 * through `screen` / `document.body`, never a `render()` container.
 */

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const BOOK_ID = 'bk_abc123';
const KINDLE_ADDRESS = 'todd@kindle.com';
const MASKED_ADDRESS = 't…d@kindle.com';
const SENDER = 'library@example.com';

const target = (over: Partial<EbookSheetTarget> = {}): EbookSheetTarget => ({
  bookId: BOOK_ID,
  title: 'The Hobbit',
  author: 'J. R. R. Tolkien',
  series: { name: 'Middle-earth', position: 1 },
  coverUrl: 'https://example.com/cover.jpg',
  companion: { format: 'epub', sizeBytes: 1536 },
  ...over,
});

const baseMe: MeDto = {
  publicId: 'us_1',
  username: 'todd',
  authProvider: 'local',
  email: null,
  thumb: null,
  role: 'user',
  status: 'active',
  requestQuota: { mode: 'inherit' },
  autoApprove: false,
  createdAt: '2026-07-01T00:00:00.000Z',
  quota: { mode: 'unlimited', limit: null, used: 0, remaining: null, windowDays: 30 },
  notifyOn: [],
  emailNotifyAvailable: false,
  kindleEmail: KINDLE_ADDRESS,
};

const FEATURES_A: FeaturesDto = { ebooksEnabled: true, kindleDeliveryAvailable: true, kindleSenderEmail: SENDER };
const FEATURES_NO_KINDLE: FeaturesDto = {
  ebooksEnabled: true,
  kindleDeliveryAvailable: false,
  kindleSenderEmail: null,
};

/** A minimal stand-in for the bits of `Response` the sheet's DOWNLOAD path actually reads. */
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

/** A minimal stand-in for the bits `api.ts`'s `parse()` reads — the JSON routes. */
const jsonRes = (status: number, payload: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(payload)),
  }) as unknown as Response;

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
let openAccount: Mock<() => void>;
/** The `RequestInit` of every ACTION fetch the sheet made (download / send), in order. */
let fetchCalls: [string, RequestInit | undefined][];
let fetchResponder: () => Promise<Response>;
let sendResponder: () => Promise<Response>;
let meBody: MeDto;
let featuresResponder: () => Promise<Response>;
/** Set by the deferred features responder, so a test can settle `/api/features` deliberately. */
let settleFeatures: ((response: Response) => void) | null;
let client: QueryClient;

beforeEach(() => {
  save = vi.fn<SaveBlob>();
  navigate = vi.fn<NavigateToDownload>();
  onClose = vi.fn<() => void>();
  openAccount = vi.fn<() => void>();
  fetchCalls = [];
  fetchResponder = () => Promise.resolve(okDownload());
  sendResponder = () => Promise.resolve(jsonRes(200, { outcome: 'sent' }));
  meBody = { ...baseMe };
  featuresResponder = () => Promise.resolve(jsonRes(200, FEATURES_A));
  settleFeatures = null;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      // The two LIVE queries the sheet reads through. Kept out of `fetchCalls` so the action
      // assertions ("exactly one request") stay about the sheet's own actions.
      if (url.startsWith('/api/me')) return Promise.resolve(jsonRes(200, meBody));
      if (url.startsWith('/api/features')) return featuresResponder();
      fetchCalls.push([url, init]);
      return url.includes('/send-to-kindle') ? sendResponder() : fetchResponder();
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/** The sheet under a real query client and the account-modal seam, exactly as `Layout` provides it. */
function renderSheetRaw(over: Partial<EbookSheetTarget> = {}) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <OpenAccountModalContext.Provider value={openAccount}>
        <EbookSheet target={target(over)} onClose={onClose} save={save} navigate={navigate} />
      </OpenAccountModalContext.Provider>
    </QueryClientProvider>,
  );
}

/**
 * Render and WAIT for the features query to reach a TERMINAL state, then flush the render it
 * schedules. Everything after this runs against a proven state rather than an accidental
 * observation of the still-loading one — which is what makes the synchronous absence assertions
 * below real negatives.
 */
async function renderSheet(over: Partial<EbookSheetTarget> = {}) {
  const view = renderSheetRaw(over);
  await settled();
  return view;
}

async function settled(): Promise<void> {
  await waitFor(() => expect(client.getQueryState(qk.features)?.status).toMatch(/success|error/));
  await act(async () => {});
}

const downloadButton = () => screen.getByRole('button', { name: /download ebook|downloading/i });
const sendButton = () => screen.getByRole('button', { name: /send to kindle|sending/i });
const allowlistLink = () => screen.queryByRole('link', { name: AMAZON_APPROVED_LIST_LINK_LABEL });
const expanderTrigger = () => screen.queryByRole('button', { name: AMAZON_APPROVED_LIST_DISCLOSURE_LABEL });
const accountHint = () => screen.queryByRole('button', { name: KINDLE_ADDRESS_HINT_ACTION });

/** True when Send is rendered BEFORE Download in document order. */
const sendRendersFirst = (): boolean =>
  Boolean(sendButton().compareDocumentPosition(downloadButton()) & Node.DOCUMENT_POSITION_FOLLOWING);

/** The sheet's amber-primary controls — the invariant is that there is exactly ONE. */
const primaryControls = (): Element[] =>
  Array.from(screen.getByRole('dialog').querySelectorAll('button.shadow-glow'));

const isPrimary = (el: HTMLElement): boolean =>
  el.classList.contains('shadow-glow') && el.classList.contains('bg-primary');

describe('EbookSheet — content', () => {
  it('renders cover, title, author, series and the EPUB + size chips', async () => {
    await renderSheet();

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

  it('wires labelledBy so the dialog has the book title as its ACCESSIBLE NAME', async () => {
    // Asserting the role and the title text separately would still pass with the id unwired.
    await renderSheet();
    expect(screen.getByRole('dialog', { name: 'The Hobbit' })).toBeInTheDocument();
  });

  it('shows NO narrator or audio-edition metadata (the sheet is ebook context)', async () => {
    await renderSheet();
    expect(screen.queryByText(/narrat/i)).toBeNull();
    expect(screen.queryByText(/Rob Inglis/)).toBeNull();
  });

  it.each([
    ['a null author', { author: null }],
    ['an empty author string (an empty `authors` array upstream)', { author: '' }],
  ])('omits the author row entirely for %s — no placeholder copy', async (_label, over) => {
    await renderSheet(over);
    expect(screen.queryByText(/unknown author/i)).toBeNull();
    expect(screen.queryByText('J. R. R. Tolkien')).toBeNull();
  });

  it('omits the series row when the host has none', async () => {
    await renderSheet({ series: null });
    expect(screen.queryByText('Middle-earth')).toBeNull();
  });

  it('renders a zero-byte companion as "0 B" and a non-finite one with NO size chip', async () => {
    const zero = await renderSheet({ companion: { format: 'epub', sizeBytes: 0 } });
    expect(screen.getByText('0 B')).toBeInTheDocument();
    zero.unmount();

    await renderSheet({ companion: { format: 'epub', sizeBytes: NaN } });
    expect(screen.getByText('EPUB')).toBeInTheDocument();
    expect(screen.queryByText(/NaN|undefined/)).toBeNull();
  });

  it('falls back to the title tile when the cover image ERRORS', async () => {
    await renderSheet();
    const img = screen.getByRole('img', { name: 'Cover of The Hobbit' });

    await userEvent.click(downloadButton()); // no-op for this assertion; keeps act() happy
    img.dispatchEvent(new Event('error'));

    await waitFor(() => expect(screen.queryByRole('img', { name: 'Cover of The Hobbit' })).toBeNull());
    // The title survives as the placeholder tile's own content, beside the heading.
    expect(screen.getAllByText('The Hobbit').length).toBeGreaterThan(1);
  });

  it('renders the placeholder tile when there is NO cover at all', async () => {
    await renderSheet({ coverUrl: null });
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getAllByText('The Hobbit').length).toBeGreaterThan(1);
  });
});

describe('EbookSheet — the download happy path', () => {
  it('makes exactly ONE same-origin request and hands the assembled blob to the save seam', async () => {
    await renderSheet();

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

  // #149 AC27: the same happy path from STATE A, where Download is now the SECONDARY control and
  // renders second. Position and variant changed; behavior did not.
  it('still downloads from State A, where Download is secondary and second in order', async () => {
    await renderSheet();
    expect(sendRendersFirst()).toBe(true);
    expect(isPrimary(downloadButton())).toBe(false);

    await userEvent.click(downloadButton());

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]![0]).toBe(`/api/ebooks/${BOOK_ID}/download?title=The+Hobbit`);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('falls back to companion.epub when the response carries no usable filename', async () => {
    fetchResponder = () => Promise.resolve(response({ body: bodyOf(new Uint8Array([9])) }));
    await renderSheet();

    await userEvent.click(downloadButton());

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![1]).toBe('companion.epub');
  });

  it('locks the button while a BUFFERED download is in flight, so a double-click can’t burn two', async () => {
    let release!: (value: Response) => void;
    fetchResponder = () => new Promise<Response>((resolve) => (release = resolve));
    await renderSheet();

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
    await renderSheet();

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
    await renderSheet();

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
    await renderSheet();

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
    await renderSheet();

    await userEvent.click(downloadButton());

    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(toast.error).toHaveBeenCalledWith(GENERIC_DOWNLOAD_ERROR);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(downloadButton()).not.toBeDisabled();
  });
});

describe('EbookSheet — the buffer bound (AC28)', () => {
  it('takes navigate mode with NO fetch at all when the companion is already over the bound', async () => {
    await renderSheet({ companion: { format: 'epub', sizeBytes: MAX_BUFFERED_EPUB_BYTES + 1 } });

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
    await renderSheet();

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
    await renderSheet();

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

  const renderHost = () => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={client}>
        <OpenAccountModalContext.Provider value={openAccount}>
          <Host />
        </OpenAccountModalContext.Provider>
      </QueryClientProvider>,
    );
  };

  it('closes on Esc and returns focus to the trigger', async () => {
    renderHost();
    const trigger = screen.getByRole('button', { name: 'Get eBook' });
    await userEvent.click(trigger);
    expect(screen.getByRole('dialog', { name: 'The Hobbit' })).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(trigger).toHaveFocus();
  });

  it('closes on the X button', async () => {
    renderHost();
    await userEvent.click(screen.getByRole('button', { name: 'Get eBook' }));

    await userEvent.click(screen.getByRole('button', { name: 'Close' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

// --- Send to Kindle: the button hierarchy (#149 AC2–AC4) ----------------------

describe('EbookSheet — State A (an address saved, delivery available)', () => {
  it('puts Send FIRST as the amber primary with Download secondary beneath, both enabled', async () => {
    await renderSheet();

    expect(sendRendersFirst()).toBe(true);
    expect(isPrimary(sendButton())).toBe(true);
    expect(isPrimary(downloadButton())).toBe(false);
    expect(downloadButton().className).toContain('border-border');
    expect(sendButton()).toBeEnabled();
    expect(downloadButton()).toBeEnabled();
    // The sheet-wide invariant: exactly ONE amber button, whatever the state.
    expect(primaryControls()).toHaveLength(1);
  });

  it('renders the masked caption naming the sender, and the allowlist education', async () => {
    await renderSheet();

    expect(screen.getByText(`Sends to ${MASKED_ADDRESS} · arrives from ${SENDER}`)).toBeInTheDocument();
    // One quiet row (UAT de-busying): the link folded inside the disclosure, so at rest only
    // the trigger shows — the caption above already names the sender.
    expect(expanderTrigger()).toBeInTheDocument();
    expect(allowlistLink()).toBeNull();
  });

  it('NEVER puts the full Kindle address in the sheet’s DOM — text or attribute', async () => {
    await renderSheet();

    // `Dialog` portals into <body>, so the render container does NOT contain the sheet — asserting
    // against `container.innerHTML` here would pass with the whole address on screen.
    expect(document.body.innerHTML).not.toContain(KINDLE_ADDRESS);
    // Paired with the POSITIVE, so the negative cannot pass by rendering nothing at all.
    expect(document.body.innerHTML).toContain(MASKED_ADDRESS);
  });

  it('omits the whole "arrives from" clause when the sender is null, never rendering `null`', async () => {
    featuresResponder = () =>
      Promise.resolve(jsonRes(200, { ebooksEnabled: true, kindleDeliveryAvailable: true, kindleSenderEmail: null }));
    await renderSheet();

    expect(screen.getByText(`Sends to ${MASKED_ADDRESS}`)).toBeInTheDocument();
    expect(screen.queryByText(/arrives from/)).toBeNull();
    expect(document.body.innerHTML).not.toMatch(/\bnull\b|\bundefined\b/);
    // Send is still the primary — a missing sender is the server's invariant break, not the user's.
    expect(isPrimary(sendButton())).toBe(true);
  });
});

describe('EbookSheet — State B (delivery available, no address saved)', () => {
  beforeEach(() => {
    meBody = { ...baseMe, kindleEmail: null };
  });

  it('puts Download FIRST as the amber primary, with Send disabled and NON-primary beneath', async () => {
    await renderSheet();

    expect(sendRendersFirst()).toBe(false);
    expect(isPrimary(downloadButton())).toBe(true);
    expect(sendButton()).toBeDisabled();
    // A disabled-but-amber Send would leave two primary-styled controls on screen.
    expect(isPrimary(sendButton())).toBe(false);
    expect(primaryControls()).toHaveLength(1);
    expect(downloadButton()).toBeEnabled();
  });

  it('renders exactly one hint line, whose action opens the account modal through the seam', async () => {
    await renderSheet();

    const hint = accountHint();
    expect(hint).toBeInTheDocument();
    expect(hint!.closest('p')!.textContent).toBe(
      `Send to Kindle needs your device address — ${KINDLE_ADDRESS_HINT_ACTION}`,
    );

    await userEvent.click(hint!);

    // A callback, never an <a href> that would navigate the SPA and unmount the sheet.
    expect(openAccount).toHaveBeenCalledTimes(1);
    // One modal at a time: the sheet steps aside for the account modal.
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders NO masked caption, NO allowlist link and NO expander (meaningless without an address)', async () => {
    await renderSheet();

    // Synchronous, against a features query proven terminal by `renderSheet`.
    expect(screen.queryByText(/Sends to/)).toBeNull();
    expect(screen.queryByText(/arrives from/)).toBeNull();
    expect(allowlistLink()).toBeNull();
    expect(expanderTrigger()).toBeNull();
    expect(screen.queryByText(KINDLE_DELIVERY_UNAVAILABLE)).toBeNull();
  });

  it.each([
    ['an empty string', ''],
    ['a whitespace-only value', '   '],
  ])('treats %s as no address at all', async (_label, kindleEmail) => {
    meBody = { ...baseMe, kindleEmail };
    await renderSheet();

    expect(sendButton()).toBeDisabled();
    expect(accountHint()).toBeInTheDocument();
    expect(screen.queryByText(/Sends to/)).toBeNull();
  });
});

describe('EbookSheet — State C (the instance cannot send)', () => {
  /** Every State-C assertion, run against whatever terminal features state the caller set up. */
  function expectStateC(): void {
    expect(sendRendersFirst()).toBe(false);
    expect(isPrimary(downloadButton())).toBe(true);
    expect(downloadButton()).toBeEnabled();
    expect(sendButton()).toBeDisabled();
    expect(isPrimary(sendButton())).toBe(false);
    expect(primaryControls()).toHaveLength(1);
    expect(screen.getByText(KINDLE_DELIVERY_UNAVAILABLE)).toBeInTheDocument();
    // No account hint — adding an address would not help. No sender copy, link or expander either.
    expect(accountHint()).toBeNull();
    expect(allowlistLink()).toBeNull();
    expect(expanderTrigger()).toBeNull();
    expect(screen.queryByText(/Sends to/)).toBeNull();
  }

  it('renders honest unavailable copy when /api/features reports no usable sender', async () => {
    featuresResponder = () => Promise.resolve(jsonRes(200, FEATURES_NO_KINDLE));
    await renderSheet();
    expect(client.getQueryState(qk.features)?.status).toBe('success');

    expectStateC();
  });

  it('is identical when the features query ERRORS (fail-safe, not a fallback to State A)', async () => {
    featuresResponder = () =>
      Promise.resolve(jsonRes(500, { error: { code: 'INTERNAL', message: 'boom' } }));
    await renderSheet();
    // Proven TERMINAL before the absences below: `kindleDeliveryVisible()` is false for `pending`
    // too, so an unsynchronized assertion would pass whether or not the gate works.
    expect(client.getQueryState(qk.features)?.status).toBe('error');

    expectStateC();
  });

  // THE case that actually proves the fail-safe gate is wired (#149 AC5). Every OTHER State-C case
  // has `data === undefined`, so `kindleDeliveryVisible(features)` and a naive
  // `features.data?.kindleDeliveryAvailable === true` are INDISTINGUISHABLE — the whole suite stays
  // green with the gate deleted. React Query retains the last successful payload when a refetch
  // fails (the reducer sets `status: 'error'` and leaves `data` alone), so a retained-payload error
  // is the one state where `!state.isError` is the deciding term rather than a no-op: the gate says
  // "hide", a raw `.data` read says "show from stale data".
  it('fails safe to State C when a REFETCH errors while the successful payload is retained', async () => {
    await renderSheet();
    expect(isPrimary(sendButton())).toBe(true); // State A, from a genuinely successful fetch

    featuresResponder = () => Promise.resolve(jsonRes(500, { error: { code: 'INTERNAL', message: 'boom' } }));
    await act(async () => {
      await client.refetchQueries({ queryKey: qk.features });
    });

    // The premise, asserted rather than assumed: the query is ERRORED and STILL holding the
    // successful payload. Without the retention half a raw `.data` read would fail safe by
    // accident and this case would prove nothing.
    expect(client.getQueryState(qk.features)?.status).toBe('error');
    expect(client.getQueryState(qk.features)?.data).toEqual(FEATURES_A);

    // The observer re-renders ASYNCHRONOUSLY on this transition — settling the refetch inside
    // `act` is not enough, because the notification is scheduled rather than applied inline. Wait
    // for the POSITIVE effect of the gate first, so the synchronous absence assertions inside
    // `expectStateC()` run against a state that has actually landed.
    await waitFor(() => expect(sendButton()).toBeDisabled());

    expectStateC();
  });

  it('is also the answer while the features query is genuinely still IN FLIGHT', async () => {
    featuresResponder = () =>
      new Promise<Response>((resolve) => {
        settleFeatures = resolve;
      });
    renderSheetRaw();

    // Positive evidence that this is the LOADING case, not a query that never started.
    await waitFor(() => expect(settleFeatures).not.toBeNull());
    expect(client.getQueryState(qk.features)?.status).toBe('pending');
    expectStateC();
  });

  it('never dispatches a send, even if the disabled control is activated programmatically', async () => {
    featuresResponder = () => Promise.resolve(jsonRes(200, FEATURES_NO_KINDLE));
    await renderSheet();

    await userEvent.click(sendButton());

    expect(fetchCalls).toHaveLength(0);
  });
});

// --- Live (not snapshotted) account + feature state (#149 AC6) ----------------

describe('EbookSheet — reads me and features LIVE while it stays open', () => {
  it('moves from State B to State A when an address lands in the me cache', async () => {
    meBody = { ...baseMe, kindleEmail: null };
    await renderSheet();
    expect(sendButton()).toBeDisabled();

    // A save in another tab / the account modal writes `qk.me`. A component that copied
    // `kindleEmail` into local state on mount would sit here disabled forever.
    await act(async () => {
      client.setQueryData(qk.me, { ...baseMe, kindleEmail: KINDLE_ADDRESS });
    });

    await waitFor(() => expect(sendButton()).toBeEnabled());
    expect(sendRendersFirst()).toBe(true);
    expect(screen.getByText(`Sends to ${MASKED_ADDRESS} · arrives from ${SENDER}`)).toBeInTheDocument();
    expect(accountHint()).toBeNull();
  });

  it('falls back from State A to State B when the address is cleared', async () => {
    await renderSheet();
    expect(sendButton()).toBeEnabled();

    await act(async () => {
      client.setQueryData(qk.me, { ...baseMe, kindleEmail: null });
    });

    await waitFor(() => expect(sendButton()).toBeDisabled());
    expect(isPrimary(downloadButton())).toBe(true);
    expect(document.body.innerHTML).not.toContain(MASKED_ADDRESS);
  });

  it('moves from State A to State C when the feature payload retires availability', async () => {
    await renderSheet();
    expect(isPrimary(sendButton())).toBe(true);

    await act(async () => {
      client.setQueryData(qk.features, FEATURES_NO_KINDLE);
    });

    await waitFor(() => expect(screen.queryByText(KINDLE_DELIVERY_UNAVAILABLE)).toBeInTheDocument());
    expect(sendButton()).toBeDisabled();
    expect(isPrimary(downloadButton())).toBe(true);
    expect(primaryControls()).toHaveLength(1);
  });

  it('follows a SENDER change in the caption without ever exposing the device address', async () => {
    await renderSheet();

    await act(async () => {
      client.setQueryData(qk.features, { ...FEATURES_A, kindleSenderEmail: 'new-sender@example.com' });
    });

    await waitFor(() =>
      expect(screen.getByText(`Sends to ${MASKED_ADDRESS} · arrives from new-sender@example.com`)).toBeInTheDocument(),
    );
    expect(document.body.innerHTML).not.toContain(KINDLE_ADDRESS);
  });
});

// --- The allowlist education (#149 AC14–AC16) --------------------------------

describe('EbookSheet — the Amazon allowlist education', () => {
  it('opens the deep link in a new tab, with both rel tokens', async () => {
    await renderSheet();
    await userEvent.click(expanderTrigger()!);
    const link = allowlistLink()!;

    expect(link).toHaveAttribute('href', AMAZON_APPROVED_LIST_URL);
    expect(link).toHaveAttribute('target', '_blank');
    // Required: the destination is external and outside our control.
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(link.getAttribute('rel')).toContain('noreferrer');
  });

  it('keeps the click path COLLAPSED by default and toggles it both ways', async () => {
    await renderSheet();
    const trigger = expanderTrigger()!;

    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    // Genuinely absent from the DOM, not merely hidden.
    expect(screen.queryByText('Personal Document Settings')).toBeNull();
    expect(screen.queryByText('Approved Personal Document E-mail List')).toBeNull();

    await userEvent.click(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    for (const step of [
      'Amazon',
      'Account',
      'Content & Devices',
      'Preferences',
      'Personal Document Settings',
      'Approved Personal Document E-mail List',
      '“Add a new approved e-mail address”',
      'Enter the sender mailbox',
    ]) {
      expect(screen.getByText(step)).toBeInTheDocument();
    }
    expect(screen.getByText(/one-time setup per Amazon account/i)).toBeInTheDocument();
    // The trigger controls the panel it just revealed.
    expect(document.getElementById(trigger.getAttribute('aria-controls')!)).toBeInTheDocument();

    await userEvent.click(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Personal Document Settings')).toBeNull();
  });
});

// --- The send interaction (#149 AC20–AC25) -----------------------------------

describe('EbookSheet — the send request', () => {
  it('issues exactly ONE same-origin POST carrying the title', async () => {
    await renderSheet();

    await userEvent.click(sendButton());

    await screen.findByText(SENT_CONFIRMATION_HEADLINE);
    expect(fetchCalls).toHaveLength(1);
    const [url, init] = fetchCalls[0]!;
    expect(url).toBe(`/api/ebooks/${BOOK_ID}/send-to-kindle`);
    expect(init?.method).toBe('POST');
    expect(init?.credentials).toBe('same-origin');
    expect(JSON.parse(String(init?.body))).toEqual({ title: 'The Hobbit' });
  });

  // Outcome presentation is IN-SHEET since the UAT fix (2026-07-29): the first real end-to-end
  // send read as a dead click because the toast fired in a corner the modal user never saw.
  it('replaces the action area with the persistent success panel on `sent` — and raises NO toast', async () => {
    sendResponder = () => Promise.resolve(jsonRes(200, { outcome: 'sent' }));
    await renderSheet();

    await userEvent.click(sendButton());

    await screen.findByText(SENT_CONFIRMATION_HEADLINE);
    expect(screen.getByText(SENT_CONFIRMATION_DETAIL)).toBeInTheDocument();
    // Terminal state for the visit: both buttons are gone; the dialog stays for the user to close.
    expect(screen.queryByRole('button', { name: /send to kindle/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /download ebook/i })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'The Hobbit' })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it.each(EBOOK_SEND_OUTCOMES.filter((o) => o !== 'sent'))(
    'renders the %s outcome INLINE and leaves the sheet usable — no toast',
    async (outcome) => {
      sendResponder = () => Promise.resolve(jsonRes(200, { outcome }));
      await renderSheet();

      await userEvent.click(sendButton());

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(sendOutcomeMessage(outcome));
      expect(toast.error).not.toHaveBeenCalled();
      expect(toast.success).not.toHaveBeenCalled();
      // NO failure closes the sheet: Download stays available as the fallback.
      expect(screen.getByRole('dialog', { name: 'The Hobbit' })).toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
      await waitFor(() => expect(sendButton()).toBeEnabled());
      expect(downloadButton()).toBeEnabled();
    },
  );

  it.each([
    ['a 403 EBOOKS_DISABLED envelope', 403, 'EBOOKS_DISABLED'],
    ['a 500 INTERNAL envelope', 500, 'INTERNAL'],
  ])('maps %s through the error-CODE table, inline, and keeps the sheet open', async (_label, status, code) => {
    sendResponder = () => Promise.resolve(jsonRes(status, { error: { code, message: 'nope' } }));
    await renderSheet();

    await userEvent.click(sendButton());

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(sendErrorMessage(code));
    expect(toast.error).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(downloadButton()).toBeEnabled();
  });

  it.each([
    ['a rejected fetch (a network failure)', () => Promise.reject(new TypeError('network'))],
    ['a non-JSON body', () => Promise.resolve({ ok: false, status: 502, text: () => Promise.resolve('<html>') } as unknown as Response)],
  ])('falls back to the generic message, inline, for %s', async (_label, responder) => {
    sendResponder = responder;
    await renderSheet();

    await userEvent.click(sendButton());

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(GENERIC_SEND_ERROR);
    expect(toast.error).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(downloadButton()).toBeEnabled();
  });

  it('clears the inline failure while a retry is in flight', async () => {
    // The stale-error guard: text from attempt N must not sit beside attempt N+1's spinner.
    let call = 0;
    let release!: (value: Response) => void;
    sendResponder = () => {
      call += 1;
      if (call === 1) return Promise.resolve(jsonRes(200, { outcome: 'failed' }));
      return new Promise<Response>((resolve) => (release = resolve));
    };
    await renderSheet();

    await userEvent.click(sendButton());
    await screen.findByRole('alert');

    await userEvent.click(sendButton());
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());

    release(jsonRes(200, { outcome: 'sent' }));
    await screen.findByText(SENT_CONFIRMATION_HEADLINE);
  });
});

describe('EbookSheet — the two actions hold INDEPENDENT locks (AC22)', () => {
  it('locks Send while its POST is in flight while Download stays fully usable', async () => {
    let release!: (value: Response) => void;
    sendResponder = () => new Promise<Response>((resolve) => (release = resolve));
    await renderSheet();

    await userEvent.click(sendButton());
    await waitFor(() => expect(sendButton()).toBeDisabled());

    // A second click must not burn a second admission.
    await userEvent.click(sendButton());
    expect(fetchCalls.filter(([url]) => url.includes('send-to-kindle'))).toHaveLength(1);

    // …and the send's pending state takes NO lock the download shares.
    expect(downloadButton()).toBeEnabled();
    await userEvent.click(downloadButton());
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(fetchCalls.filter(([url]) => url.includes('/download'))).toHaveLength(1);

    release(jsonRes(200, { outcome: 'sent' }));
    // Post-fix terminal state: the action area becomes the success panel, not a re-enabled button.
    await screen.findByText(SENT_CONFIRMATION_HEADLINE);
  });

  it('and the reverse: a download in flight leaves Send enabled and sendable', async () => {
    let releaseDownload!: (value: Response) => void;
    fetchResponder = () => new Promise<Response>((resolve) => (releaseDownload = resolve));
    await renderSheet();

    await userEvent.click(downloadButton());
    await waitFor(() => expect(downloadButton()).toBeDisabled());

    expect(sendButton()).toBeEnabled();
    await userEvent.click(sendButton());

    await screen.findByText(SENT_CONFIRMATION_HEADLINE);
    expect(fetchCalls.filter(([url]) => url.includes('send-to-kindle'))).toHaveLength(1);

    // The success panel replaced the buttons, but the in-flight download is untouched by that —
    // releasing it still lands the file through the save seam.
    releaseDownload(okDownload());
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
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

// --- Viewport containment (#149 F4, sibling of the AccountModal instance) -----

describe('EbookSheet — the expanded education stays reachable on a short viewport', () => {
  /**
   * The sheet hosts the SAME eight-step click path as the account modal, below the cover block,
   * both actions and the caption. jsdom performs no layout, so the assertable contract is
   * `Dialog`'s scrolling MODE — a height-capped card whose content sits in an internally-scrolling
   * wrapper. Without it the card is `h-fit` inside a `position: fixed` overlay and anything past
   * the viewport bottom is unreachable, because the page behind does not scroll the overlay.
   */
  it('caps the dialog height and scrolls its body internally', async () => {
    await renderSheet();
    const card = screen.getByRole('dialog');

    expect(card.className).toContain('max-h-[85vh]');
    expect(card.className).toContain('overflow-hidden');

    const scroller = card.querySelector('.overflow-y-auto');
    expect(scroller).not.toBeNull();
    expect(scroller).toContainElement(downloadButton());
    expect(scroller).toContainElement(sendButton());
  });

  it('keeps Close pinned OUTSIDE the scrolling region', async () => {
    await renderSheet();
    const card = screen.getByRole('dialog');

    const scroller = card.querySelector('.overflow-y-auto')!;
    expect(scroller).not.toContainElement(screen.getByRole('button', { name: 'Close' }));
  });

  it('reaches the last click-path step and the one-time note once expanded', async () => {
    await renderSheet();

    await userEvent.click(expanderTrigger()!);

    const scroller = screen.getByRole('dialog').querySelector('.overflow-y-auto')!;
    expect(scroller).toContainElement(screen.getByText('Enter the sender mailbox'));
    expect(scroller).toContainElement(screen.getByText(/one-time setup per Amazon account/i));
  });
});
