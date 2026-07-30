import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MeDto } from '@shared/schemas/user';
import type { FeaturesDto } from '@shared/schemas/features';
import { Layout } from './Layout';
import { EbookSheet } from './EbookSheet';

/**
 * The END-TO-END receipt for the account-modal seam (#149 AC10/AC11).
 *
 * `EbookSheet.test.tsx` proves the sheet CALLS the seam, which is a callback assertion: it passes
 * whether or not `Layout` ever provides one, and whether or not the account modal actually becomes
 * reachable. This file closes that gap by driving the real chain — `Layout` provides
 * `OpenAccountModalContext`, the sheet consumes it from inside `Outlet`, and the `AccountModal`
 * `Layout` owns opens. The seam is a CONTEXT rather than a per-host prop, so one receipt covers
 * both production hosts (the search card and the My Requests row); neither host touches it.
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
  // State B: delivery works, but this user has no device address — the one state that renders the
  // "add it in your account" hint.
  kindleEmail: null,
};

/** Delivery available, so the sheet is in State B rather than State C. */
const FEATURES: FeaturesDto = {
  ebooksEnabled: true,
  kindleDeliveryAvailable: true,
  kindleSenderEmail: 'library@example.com',
};

const jsonRes = (status: number, payload: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(payload)),
  }) as unknown as Response;

beforeEach(() => {
  // `matchMedia` (which `Layout` needs for useTheme) comes from the shared jsdom setup stub.
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/me')) return Promise.resolve(jsonRes(200, me));
      if (url.startsWith('/api/features')) return Promise.resolve(jsonRes(200, FEATURES));
      if (url.startsWith('/api/auth/providers')) return Promise.resolve(jsonRes(200, { local: true, providers: [] }));
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/** A route child standing in for either production host: it just mounts the sheet under `Outlet`. */
function SheetHost({ onClose }: { onClose: () => void }) {
  return (
    <EbookSheet
      target={{
        bookId: 'bk_abc123',
        title: 'The Hobbit',
        author: null,
        series: null,
        coverUrl: null,
        companion: { format: 'epub', sizeBytes: 1536 },
      }}
      onClose={onClose}
      save={() => {}}
      navigate={() => {}}
    />
  );
}

function renderApp(onClose = () => {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Routes>
          <Route element={<Layout me={me} />}>
            <Route index element={<SheetHost onClose={onClose} />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Layout — the account-modal seam the ebook sheet reaches (#149 AC10/AC11)', () => {
  it('opens the REAL account modal from the sheet’s State-B hint', async () => {
    let open = true;
    const view = renderApp(() => {
      open = false;
    });

    // The sheet is up and the account modal is not.
    expect(await screen.findByRole('dialog', { name: 'The Hobbit' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Kindle address')).toBeNull();

    await userEvent.click(await screen.findByRole('button', { name: 'add it in your account' }));

    // The account modal — Layout's own, opened through the context — is genuinely reachable, with
    // the Kindle row the hint pointed the user at.
    expect(await screen.findByLabelText('Kindle address')).toBeInTheDocument();
    // …and the sheet asked its host to close, so the two are not stacked.
    expect(open).toBe(false);

    // Re-render without the sheet, exactly as the host would on that close, and confirm the
    // account modal is the ONE dialog left standing.
    view.rerender(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <Routes>
            <Route element={<Layout me={me} />}>
              <Route index element={null} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'The Hobbit' })).toBeNull());
  });

  it('leaves the nav’s own account trigger working (the seam is additive)', async () => {
    renderApp();
    await screen.findByRole('dialog', { name: 'The Hobbit' });

    await userEvent.click(screen.getByRole('button', { name: 'Account' }));

    expect(await screen.findByLabelText('Kindle address')).toBeInTheDocument();
  });
});
