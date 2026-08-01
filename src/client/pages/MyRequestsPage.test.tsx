import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { RequestDto, RequestStatus } from '@shared/schemas/request';
import type { MeDto } from '@shared/schemas/user';
import type { FeaturesDto } from '@shared/schemas/features';
import type { V1CompanionEbook } from '@shared/schemas/v1/companion-ebook';
import { qk } from '../hooks';
import { MyRequestsPage, RequestRow } from './MyRequestsPage';

/**
 * DOM-only coverage for the My Requests Get-eBook affordance (#147). The row matrix runs against
 * the exported `RequestRow` (a focused prop surface); the PAGE-level cases exercise the real
 * `ebooksVisible(useFeatures(useMe().data))` wiring through the genuine query hooks and a `fetch`
 * stub, so a row test passing a boolean prop can never stand in for it.
 *
 * Absence assertions are SYNCHRONOUS `queryBy*` — `vi.waitFor` passes on its first tick.
 */

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const EPUB: V1CompanionEbook = { format: 'epub', sizeBytes: 1536 };

const row = (over: Partial<RequestDto> = {}): RequestDto => ({
  publicId: 'rq_1',
  asin: 'B01',
  title: 'The Hobbit',
  author: 'J. R. R. Tolkien',
  narrator: 'Rob Inglis',
  coverUrl: null,
  status: 'available',
  note: null,
  failureReason: null,
  requestedAt: '2026-07-01T00:00:00.000Z',
  decidedAt: null,
  narratorrBookId: 'bk_abc123',
  companionEbook: EPUB,
  requester: { publicId: 'us_1', username: 'todd' },
  ...over,
});

const getEbookButton = () => screen.queryByRole('button', { name: /get ebook/i });

/**
 * The row opens the shared sheet, and the sheet reads `/api/me` + `/api/features` LIVE (#149), so
 * every row case needs a real client and a routed `fetch` — a provider-less render now throws in
 * `useMe`. The routing is deliberately minimal and DETERMINISTIC (State A: an address saved,
 * delivery available), so the download assertions below keep exercising an enabled Download button
 * and nothing here depends on a query race.
 */
// A function, not a const: `me` and `jsonRes` are declared further down (with the page-level
// harness) and would be in the temporal dead zone at module-evaluation time.
const rowMe = (): MeDto => ({ ...me, kindleEmail: 'todd@kindle.com' });
const ROW_FEATURES = {
  ebooksEnabled: true,
  kindleDeliveryAvailable: true,
  kindleSenderEmail: 'library@example.com',
} satisfies FeaturesDto;

/**
 * A `fetch` stub answering the sheet's two live queries and delegating everything else to
 * `rest` — so a case that needs to hold its own download response open still can, without
 * stranding `/api/me` and silently changing which sheet state it is testing.
 */
function installRowFetch(rest: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/me')) return Promise.resolve(jsonRes(200, rowMe()));
      if (url.startsWith('/api/features')) return Promise.resolve(jsonRes(200, ROW_FEATURES));
      return rest(input, init);
    }),
  );
}

const rowTree = (props: Parameters<typeof RequestRow>[0], client: QueryClient) => (
  <QueryClientProvider client={client}>
    <ul>
      <RequestRow {...props} />
    </ul>
  </QueryClientProvider>
);

function renderRow(props: Parameters<typeof RequestRow>[0]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(rowTree(props, client));
  return {
    ...view,
    /** Re-render the same row through the SAME client, so the sheet's queries are not torn down. */
    rerenderRow: (next: Parameters<typeof RequestRow>[0]) => view.rerender(rowTree(next, client)),
  };
}

describe('RequestRow — Get eBook affordance', () => {
  beforeEach(() => {
    installRowFetch((input) => Promise.reject(new Error(`unexpected fetch: ${String(input)}`)));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('renders the button beside the status badge and opens the shared sheet', async () => {
    renderRow({ r: row(), ebooksEnabled: true });

    const button = getEbookButton();
    expect(button).toBeInTheDocument();
    // Beside the badge, not somewhere else in the row.
    expect(button!.parentElement).toBe(screen.getByText('Available').parentElement);

    await userEvent.click(button!);

    expect(await screen.findByRole('dialog', { name: 'The Hobbit' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /download ebook/i })).toBeInTheDocument();
    // The sheet is EBOOK context — the row's narrator string must not leak into it.
    expect(screen.getByRole('dialog').textContent).not.toContain('Rob Inglis');
  });

  it.each([
    ['a null companion', { companionEbook: null }],
    ['an acquiring status WITH a companion', { status: 'acquiring' as RequestStatus }],
    ['a pending status', { status: 'pending' as RequestStatus }],
    ['a null narratorrBookId', { narratorrBookId: null }],
    ['an INVALID narratorrBookId', { narratorrBookId: 'bk_bad/part' }],
    ['a 65-character narratorrBookId', { narratorrBookId: `bk_${'a'.repeat(62)}` }],
  ])('renders no button for %s', (_label, over) => {
    // The two id cases are the no-dead-button gate: without it the row would paint a button whose
    // download can only ever 404.
    renderRow({ r: row(over), ebooksEnabled: true });
    expect(getEbookButton()).toBeNull();
  });

  it('renders no button and NO chip with the feature off — the chip is a search-card affordance', () => {
    renderRow({ r: row(), ebooksEnabled: false });
    expect(getEbookButton()).toBeNull();
    expect(screen.queryByText('No eBook')).toBeNull();
  });

  it('never renders the "No eBook" chip, even for an available row without a companion', () => {
    renderRow({ r: row({ companionEbook: null }), ebooksEnabled: true });
    expect(screen.queryByText('No eBook')).toBeNull();
  });

  it('keeps an open sheet mounted when a poll flips the row’s companion to null', async () => {
    // `useMyRequestsPaged` refetches every 4s and a transient lookup failure legitimately answers
    // `null`. The sheet is driven off a click-time SNAPSHOT, so it closes only via its own controls.
    const view = renderRow({ r: row(), ebooksEnabled: true });
    await userEvent.click(getEbookButton()!);
    expect(await screen.findByRole('dialog', { name: 'The Hobbit' })).toBeInTheDocument();

    view.rerenderRow({ r: row({ companionEbook: null }), ebooksEnabled: true });

    expect(screen.getByRole('dialog', { name: 'The Hobbit' })).toBeInTheDocument();
    expect(getEbookButton()).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('keeps the sheet mounted through a rerender while the download is still PENDING', async () => {
    // The row hosts the sheet with its DEFAULT save seam, so neutralize the anchor click —
    // jsdom implements no navigation and would log "Not implemented" when the save lands.
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    let release!: (value: Response) => void;
    // Only the DOWNLOAD is held open — `/api/me` and `/api/features` still answer, so the sheet is
    // in a known state rather than stranded mid-query.
    installRowFetch(() => new Promise<Response>((resolve) => (release = resolve)));
    const view = renderRow({ r: row(), ebooksEnabled: true });
    await userEvent.click(getEbookButton()!);
    await userEvent.click(await screen.findByRole('button', { name: /download ebook/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /downloading/i })).toBeDisabled());

    view.rerenderRow({ r: row({ companionEbook: null }), ebooksEnabled: true });
    expect(screen.getByRole('dialog', { name: 'The Hobbit' })).toBeInTheDocument();

    release({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
          controller.close();
        },
      }),
    } as unknown as Response);

    // The in-flight state settles predictably rather than being stranded by the rerender.
    await waitFor(() => expect(screen.getByRole('button', { name: /download ebook/i })).not.toBeDisabled());
  });
});

// --- the page-level feature source (AC20) ------------------------------------

const me: MeDto = {
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
  kindleEmail: null,
};

const jsonRes = (status: number, payload: unknown): Response =>
  ({ ok: status >= 200 && status < 300, status, text: () => Promise.resolve(JSON.stringify(payload)) }) as unknown as Response;

const FEATURES_ON = { ebooksEnabled: true, kindleDeliveryAvailable: false, kindleSenderEmail: null } satisfies FeaturesDto;
const FEATURES_OFF = { ebooksEnabled: false, kindleDeliveryAvailable: false, kindleSenderEmail: null } satisfies FeaturesDto;

/**
 * `/api/features` is answered by a DEFERRED promise the test resolves itself. The request rows
 * arrive on an INDEPENDENT fetch (and `useFeatures` only starts after `/api/me` resolves), so
 * waiting for a row proves nothing about the feature query — holding this response and settling it
 * deliberately is what lets each case assert against a known TERMINAL query state.
 */
let settleFeatures: ((response: Response) => void) | null;

function renderPage(): QueryClient {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/me')) return Promise.resolve(jsonRes(200, me));
      if (url.startsWith('/api/features')) {
        return new Promise<Response>((resolve) => {
          settleFeatures = resolve;
        });
      }
      if (url.startsWith('/api/requests')) return Promise.resolve(jsonRes(200, { data: [row()], total: 1 }));
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <MyRequestsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

/**
 * Settle the held `/api/features` request and WAIT for the query to reach `status`, then flush the
 * render it schedules — so every assertion after this runs against a proven terminal state rather
 * than an accidental observation of the still-loading one.
 */
async function settleFeaturesTo(client: QueryClient, response: Response, status: 'success' | 'error') {
  await waitFor(() => expect(settleFeatures).not.toBeNull());
  await act(async () => {
    settleFeatures!(response);
  });
  await waitFor(() => expect(client.getQueryState(qk.features)?.status).toBe(status));
  await act(async () => {});
}

describe('MyRequestsPage — the real feature source', () => {
  beforeEach(() => {
    settleFeatures = null;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('renders the affordance once /api/features resolves ENABLED', async () => {
    const client = renderPage();
    expect(await screen.findByText('The Hobbit')).toBeInTheDocument();

    await settleFeaturesTo(client, jsonRes(200, FEATURES_ON), 'success');

    expect(getEbookButton()).toBeInTheDocument();
  });

  it.each([
    ['resolved OFF', jsonRes(200, FEATURES_OFF), 'success' as const],
    ['ERRORED with a 500', jsonRes(500, { error: { code: 'INTERNAL', message: 'boom' } }), 'error' as const],
  ])('renders NO affordance once /api/features has %s (fail-safe)', async (_label, response, status) => {
    const client = renderPage();
    expect(await screen.findByText('The Hobbit')).toBeInTheDocument();

    await settleFeaturesTo(client, response, status);

    // Synchronous, against a PROVEN terminal state: vi.waitFor cannot assert an absence.
    expect(getEbookButton()).toBeNull();
  });

  it('renders NO affordance while /api/features is genuinely still in flight', async () => {
    const client = renderPage();
    expect(await screen.findByText('The Hobbit')).toBeInTheDocument();

    // Positive evidence this is the LOADING case rather than a query that never started.
    await waitFor(() => expect(settleFeatures).not.toBeNull());
    expect(client.getQueryState(qk.features)?.status).toBe('pending');
    expect(getEbookButton()).toBeNull();
  });
});
