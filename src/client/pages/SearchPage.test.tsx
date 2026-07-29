import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MeDto } from '@shared/schemas/user';
import type { FeaturesDto } from '@shared/schemas/features';
import type { V1AudibleResult } from '@shared/schemas/v1/metadata';
import { qk } from '../hooks';
import { SearchPage } from './SearchPage';

/**
 * The PAGE-level half of the search-card ebook coverage (#147): that `SearchPage` sources the flag
 * from the real `ebooksVisible(useFeatures(useMe().data))` and treats loading/errored as OFF. The
 * card's own rendering matrix lives in `BookCard.test.tsx` against a boolean prop, which by
 * construction cannot prove this wiring.
 */

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

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

const hit: V1AudibleResult = {
  asin: 'B01',
  title: 'The Hobbit',
  authors: [{ name: 'J. R. R. Tolkien' }],
  narrators: [{ name: 'Rob Inglis' }],
  cover: 'https://example.com/c.jpg',
  library: { bookId: 'bk_abc123', status: 'imported', companionEbook: { format: 'epub', sizeBytes: 1536 } },
};

const jsonRes = (status: number, payload: unknown): Response =>
  ({ ok: status >= 200 && status < 300, status, text: () => Promise.resolve(JSON.stringify(payload)) }) as unknown as Response;

const FEATURES_ON = { ebooksEnabled: true, kindleDeliveryAvailable: false, kindleSenderEmail: null } satisfies FeaturesDto;
const FEATURES_OFF = { ebooksEnabled: false, kindleDeliveryAvailable: false, kindleSenderEmail: null } satisfies FeaturesDto;

/**
 * `/api/features` is answered by a DEFERRED promise the test resolves itself. The search results
 * arrive on an INDEPENDENT fetch, so waiting for a card proves nothing about the feature query —
 * holding this response and settling it deliberately is what lets each case assert against a
 * known TERMINAL query state instead of racing one.
 */
let settleFeatures: ((response: Response) => void) | null;

beforeEach(() => {
  settleFeatures = null;
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
      if (url.startsWith('/api/search')) return Promise.resolve(jsonRes(200, { data: [hit] }));
      if (url.startsWith('/api/requests')) return Promise.resolve(jsonRes(200, { data: [], total: 0 }));
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function searchFor(term: string): Promise<QueryClient> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SearchPage />
    </QueryClientProvider>,
  );
  await userEvent.type(screen.getByRole('searchbox'), term);
  await userEvent.click(screen.getByRole('button', { name: 'Search' }));
  expect(await screen.findByText('The Hobbit')).toBeInTheDocument();
  return client;
}

/**
 * Settle the held `/api/features` request and WAIT for the query to reach `status`, then flush the
 * render it schedules. Every assertion after this runs against a proven terminal state, which is
 * what makes the following synchronous `queryBy*` a real negative rather than an accidental
 * observation of the still-loading state.
 */
async function settleFeaturesTo(client: QueryClient, response: Response, status: 'success' | 'error') {
  await waitFor(() => expect(settleFeatures).not.toBeNull());
  await act(async () => {
    settleFeatures!(response);
  });
  await waitFor(() => expect(client.getQueryState(qk.features)?.status).toBe(status));
  await act(async () => {});
}

const getEbookButton = () => screen.queryByRole('button', { name: /get ebook/i });

describe('SearchPage — the real feature source', () => {
  it('passes the flag through to the cards once /api/features resolves ENABLED', async () => {
    const client = await searchFor('hobbit');
    await settleFeaturesTo(client, jsonRes(200, FEATURES_ON), 'success');

    expect(getEbookButton()).toBeInTheDocument();
  });

  it.each([
    ['resolved OFF', jsonRes(200, FEATURES_OFF), 'success' as const],
    ['ERRORED with a 500', jsonRes(500, { error: { code: 'INTERNAL', message: 'boom' } }), 'error' as const],
  ])('renders no ebook affordance once /api/features has %s', async (_label, response, status) => {
    const client = await searchFor('hobbit');
    await settleFeaturesTo(client, response, status);

    // The query is PROVEN terminal above, so these absences are about the settled state — and they
    // are synchronous, because `waitFor` passes on its first tick and cannot assert an absence.
    expect(screen.getByText('In library')).toBeInTheDocument();
    expect(getEbookButton()).toBeNull();
    expect(screen.queryByText('No eBook')).toBeNull();
  });

  it('renders no ebook affordance while /api/features is genuinely still in flight', async () => {
    const client = await searchFor('hobbit');

    // Positive evidence that this is the LOADING case and not a query that never started: the
    // request was issued and is still pending. The response is deliberately never settled.
    await waitFor(() => expect(settleFeatures).not.toBeNull());
    expect(client.getQueryState(qk.features)?.status).toBe('pending');
    expect(screen.getByText('In library')).toBeInTheDocument();
    expect(getEbookButton()).toBeNull();
    expect(screen.queryByText('No eBook')).toBeNull();
  });
});
