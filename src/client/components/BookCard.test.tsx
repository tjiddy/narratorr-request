import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { V1AudibleResult } from '@shared/schemas/v1/metadata';
import type { V1CompanionEbook } from '@shared/schemas/v1/companion-ebook';
import { BookCard } from './BookCard';

/**
 * DOM-only coverage for the search card's companion-ebook affordances (#147). The state
 * PRECEDENCE and the affordance decision itself live in `book-card-state.test.ts`; what can't be
 * a pure function — which control the card actually paints in the action slot, and that the
 * feature-off card is structurally untouched — is here.
 *
 * Absence assertions are SYNCHRONOUS `queryBy*`: `vi.waitFor` passes on its first tick and cannot
 * prove a negative.
 */

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const EPUB: V1CompanionEbook = { format: 'epub', sizeBytes: 1536 };

type Library = NonNullable<V1AudibleResult['library']>;

const result = (library?: Library | null): V1AudibleResult => ({
  asin: 'B01',
  title: 'The Hobbit',
  authors: [{ name: 'J. R. R. Tolkien' }],
  narrators: [{ name: 'Rob Inglis' }],
  cover: 'https://example.com/cover.jpg',
  ...(library !== undefined && { library }),
});

const libraryWith = (companion: V1CompanionEbook | null | undefined, bookId = 'bk_abc123'): Library => ({
  bookId,
  status: 'imported',
  ...(companion !== undefined && { companionEbook: companion }),
});

beforeEach(() => {
  // The card never fetches in these cases, but `useRequestBook` needs a live client.
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no request should be made'))));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function renderCard(props: Parameters<typeof BookCard>[0]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <BookCard {...props} />
    </QueryClientProvider>,
  );
}

const getEbookButton = () => screen.queryByRole('button', { name: /get ebook/i });

describe('BookCard — companion-ebook affordance', () => {
  it('shows the "In library" badge AND a Get eBook button, and the button opens the sheet', async () => {
    renderCard({ result: result(libraryWith(EPUB)), ebooksEnabled: true });

    expect(screen.getByText('In library')).toBeInTheDocument();
    const button = getEbookButton();
    expect(button).toBeInTheDocument();

    await userEvent.click(button!);

    // The shared sheet, named by the book title (so `labelledBy` is genuinely wired).
    expect(await screen.findByRole('dialog', { name: 'The Hobbit' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /download ebook/i })).toBeInTheDocument();
  });

  it('shows the badge and a muted "No eBook" chip — and NO button — when there is no companion', () => {
    renderCard({ result: result(libraryWith(null)), ebooksEnabled: true });

    expect(screen.getByText('In library')).toBeInTheDocument();
    expect(screen.getByText('No eBook')).toBeInTheDocument();
    expect(getEbookButton()).toBeNull();
    // The chip is decoration, never an action.
    expect(screen.queryByRole('button', { name: /no ebook/i })).toBeNull();
  });

  it('shows the "No eBook" chip for a companion whose book id could never reach the handler', () => {
    renderCard({ result: result(libraryWith(EPUB, 'bk_bad/part')), ebooksEnabled: true });

    expect(screen.getByText('No eBook')).toBeInTheDocument();
    expect(getEbookButton()).toBeNull();
  });

  it('renders neither chip nor button with the feature OFF', () => {
    renderCard({ result: result(libraryWith(EPUB)), ebooksEnabled: false });

    expect(screen.getByText('In library')).toBeInTheDocument();
    expect(getEbookButton()).toBeNull();
    expect(screen.queryByText('No eBook')).toBeNull();
  });

  it('leaves the feature-off action slot STRUCTURALLY untouched — no added wrapper', () => {
    // Content assertions alone would still pass if the implementation wrapped the badge in an
    // extra element, which AC16's byte-identical requirement explicitly forbids.
    const off = renderCard({ result: result(libraryWith(EPUB)), ebooksEnabled: false });
    const slot = screen.getByText('In library').parentElement!;
    expect(slot.className).toBe('mt-auto pt-2');
    expect(slot.children).toHaveLength(1);
    const html = slot.outerHTML;
    off.unmount();

    // …and identical to a card that never heard of the feature at all.
    renderCard({ result: result(libraryWith(undefined)) });
    expect(screen.getByText('In library').parentElement!.outerHTML).toBe(html);
  });

  it.each([
    ['on the way', libraryWith(EPUB), 'downloading' as const],
    ['not in the library', null, undefined],
  ])('leaves the non-imported %s card exactly as it is today', (_label, library, status) => {
    const lib = library === null ? null : { ...library, ...(status && { status }) };
    renderCard({ result: result(lib), ebooksEnabled: true });

    expect(getEbookButton()).toBeNull();
    expect(screen.queryByText('No eBook')).toBeNull();
    if (status) expect(screen.getByText('On the way')).toBeInTheDocument();
    else expect(screen.getByRole('button', { name: 'Request' })).toBeInTheDocument();
  });

  it('keeps the viewer’s own request badge for a non-imported book (precedence unchanged)', () => {
    renderCard({ result: result({ ...libraryWith(EPUB), status: 'downloading' }), requestedStatus: 'pending', ebooksEnabled: true });

    expect(screen.getByText(/requested/i)).toBeInTheDocument();
    expect(getEbookButton()).toBeNull();
  });

  it('keeps the sheet open when the card rerenders without a companion mid-session', async () => {
    // The shared search cache refreshes the `library` annotation underneath an open dialog; the
    // sheet is driven off a SNAPSHOT, so it closes only via its own controls.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={client}>
        <BookCard result={result(libraryWith(EPUB))} ebooksEnabled />
      </QueryClientProvider>,
    );

    await userEvent.click(getEbookButton()!);
    expect(await screen.findByRole('dialog', { name: 'The Hobbit' })).toBeInTheDocument();

    view.rerender(
      <QueryClientProvider client={client}>
        <BookCard result={result(libraryWith(null))} ebooksEnabled />
      </QueryClientProvider>,
    );

    expect(screen.getByRole('dialog', { name: 'The Hobbit' })).toBeInTheDocument();
    expect(getEbookButton()).toBeNull();
    expect(screen.getByText('No eBook')).toBeInTheDocument();

    // …and it still closes on its OWN control.
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
