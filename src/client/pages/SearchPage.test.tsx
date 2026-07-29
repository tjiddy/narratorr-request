import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MeDto } from '@shared/schemas/user';
import type { FeaturesDto } from '@shared/schemas/features';
import type { V1AudibleResult } from '@shared/schemas/v1/metadata';
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

/** How `/api/features` answers. `null` = never settles (the loading case). */
let featuresResponder: (() => Promise<Response>) | null;

beforeEach(() => {
  featuresResponder = () =>
    Promise.resolve(
      jsonRes(200, { ebooksEnabled: true, kindleDeliveryAvailable: false, kindleSenderEmail: null } satisfies FeaturesDto),
    );
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/me')) return Promise.resolve(jsonRes(200, me));
      if (url.startsWith('/api/features')) {
        return featuresResponder ? featuresResponder() : new Promise<Response>(() => {});
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

async function searchFor(term: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SearchPage />
    </QueryClientProvider>,
  );
  await userEvent.type(screen.getByRole('searchbox'), term);
  await userEvent.click(screen.getByRole('button', { name: 'Search' }));
  expect(await screen.findByText('The Hobbit')).toBeInTheDocument();
}

const getEbookButton = () => screen.queryByRole('button', { name: /get ebook/i });

describe('SearchPage — the real feature source', () => {
  it('passes the flag through to the cards when /api/features says the feature is on', async () => {
    await searchFor('hobbit');
    await waitFor(() => expect(getEbookButton()).toBeInTheDocument());
  });

  it.each([
    [
      'off',
      () => Promise.resolve(jsonRes(200, { ebooksEnabled: false, kindleDeliveryAvailable: false, kindleSenderEmail: null })),
    ],
    ['errored', () => Promise.resolve(jsonRes(500, { error: { code: 'INTERNAL', message: 'boom' } }))],
    ['still loading', null],
  ])('renders the card with NO ebook affordance while /api/features is %s', async (_label, responder) => {
    featuresResponder = responder;
    await searchFor('hobbit');

    // Synchronous absence assertions — the badge is still there, the affordances are not.
    expect(screen.getByText('In library')).toBeInTheDocument();
    expect(getEbookButton()).toBeNull();
    expect(screen.queryByText('No eBook')).toBeNull();
  });
});
