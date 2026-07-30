import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import type { MeDto } from '@shared/schemas/user';
import { App } from './App';
import { qk } from './hooks';
import { getMe } from './api';

/**
 * The WIRING seam for the shell policy (#168 F11). `resolveMeShell`'s eight-row table lives in
 * `app-shell.test.ts` — a correct helper plus eight green unit rows can still coexist with an `App`
 * that kept its old error-first branch, so no assertion there crosses the helper-to-shell boundary.
 * These two rows do exactly that and nothing more: one for the changed decision (a non-401 failure
 * with retained data keeps the signed-in shell) and one for the guard that must still outrank it (a
 * 401 tears it down even with data retained). Everything else about the policy stays in the table.
 *
 * Both rows drive a REFETCH failure rather than a first-load failure, because that is the state the
 * settlement reconciliations introduced: `PATCH /api/me` and `GET /api/me` share `buildMeDto()`, so
 * the reconciliation read can fail on exactly what the write failed on, and `useMe` has
 * `retry: false`.
 */

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const ME: MeDto = {
  publicId: 'us_1',
  username: 'todd',
  authProvider: 'local',
  email: 'todd@example.com',
  thumb: null,
  role: 'user',
  status: 'active',
  requestQuota: { mode: 'inherit' },
  autoApprove: false,
  createdAt: '2026-07-01T00:00:00.000Z',
  quota: { mode: 'limited', limit: 10, used: 0, remaining: 10, windowDays: 30 },
  notifyOn: [],
  emailNotifyAvailable: false,
  kindleEmail: null,
};

const jsonRes = (status: number, payload: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(payload)),
  }) as unknown as Response;

const fail = (status: number, code: string, message: string) => jsonRes(status, { error: { code, message } });

/**
 * A `me` observer mounted BESIDE `App` on the same client. The cache reaches a refetch outcome
 * before any observer does and `act` does not flush that notification
 * (`react-query-observer-lags-cache-on-refetch-error`), so waiting on this probe is what proves the
 * error has actually reached the components before the shell is asserted. Without it, "the app is
 * still rendered" could just be the pre-error snapshot.
 */
function MeProbe() {
  const me = useQuery({ queryKey: qk.me, queryFn: getMe, retry: false, staleTime: 60_000 });
  return <span data-testid="probe">{me.isError ? 'errored' : 'ok'}</span>;
}

/** Boot the signed-in app, then make `GET /api/me` fail with the given response and refetch it. */
async function bootThenFailRefetch(failure: Response) {
  // `Layout` mounts `useTheme`, which reads `prefers-color-scheme` — jsdom implements no media
  // queries at all, so without this the signed-in branch throws before anything can be asserted.
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} })),
  );
  let meResponse = () => jsonRes(200, ME);
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url === '/api/me') return Promise.resolve(meResponse());
      if (url.startsWith('/api/config')) return Promise.resolve(jsonRes(200, { instanceBadge: null }));
      if (url.startsWith('/api/auth/providers')) return Promise.resolve(jsonRes(200, { local: true, providers: [] }));
      if (url.startsWith('/api/features'))
        return Promise.resolve(jsonRes(200, { ebooksEnabled: false, kindleDeliveryAvailable: false, kindleSenderEmail: null }));
      if (url.startsWith('/api/requests')) return Promise.resolve(jsonRes(200, { data: [], total: 0 }));
      return Promise.resolve(jsonRes(200, { data: [], total: 0 }));
    }),
  );

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <App />
      <MeProbe />
    </QueryClientProvider>,
  );
  // The signed-in shell is up: the nav is the thing only the authenticated branch renders.
  await screen.findByRole('link', { name: /My Requests/ });

  meResponse = () => failure;
  await act(async () => {
    await client.refetchQueries({ queryKey: qk.me });
  });
  // Premise, asserted not assumed: errored, with the payload RETAINED.
  expect(client.getQueryState(qk.me)?.status).toBe('error');
  expect(client.getQueryState(qk.me)?.data).toMatchObject({ publicId: 'us_1' });
  // …and the error has actually reached the mounted observers.
  await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('errored'));

  return client;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('App delegates its shell decision to resolveMeShell (#168 AC6 wiring)', () => {
  it('keeps the signed-in shell when a refetch fails non-401 with data retained (state 6)', async () => {
    await bootThenFailRefetch(fail(500, 'INTERNAL', 'quota lookup blew up'));

    // The app is still there — no full-screen error, no bounce to the login screen. This is the
    // whole point: a reconciliation GET that fails must not tear down a working session.
    expect(screen.getByRole('link', { name: /My Requests/ })).toBeInTheDocument();
    expect(screen.queryByText('quota lookup blew up')).not.toBeInTheDocument();
    expect(screen.queryByText('Sign in to request audiobooks for the library.')).not.toBeInTheDocument();
  });

  it('still tears the shell down for a 401, retained data or not (state 4)', async () => {
    await bootThenFailRefetch(fail(401, 'UNAUTHORIZED', 'session expired'));

    // The guard row. Without it the "keep the session" rule above would keep an EXPIRED session
    // rendering off a stale payload.
    await waitFor(() =>
      expect(screen.getByText('Sign in to request audiobooks for the library.')).toBeInTheDocument(),
    );
    expect(screen.queryByRole('link', { name: /My Requests/ })).not.toBeInTheDocument();
  });
});
