import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LoginPage } from './LoginPage';
import { qk, useMe } from '../hooks';

/**
 * The FORM-CONSUMER half of #201 F2. `hooks.request-error-path.test.tsx` owns the cache-layer
 * guarantee (a settlement always reads fresh, even with the submit lock forcibly bypassed); this
 * file owns the claim that the rendered form does not hand the user a way to fire a second
 * credentials POST while the first attempt is still settling.
 *
 * It has to be driven through the real `LoginPage` rather than the hook: the bypass F2 found is the
 * mode switch's `auth.reset()`, which only exists in this markup, and the thing being asserted is
 * which controls are disabled — DOM state, not a decision a pure helper could own.
 *
 * The reconciliation read is GATED throughout. With reads resolving immediately the pending window
 * closes within a tick and every disabled-state assertion here passes vacuously.
 */

const jsonRes = (status: number, payload: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(payload)),
  }) as unknown as Response;

const fail = (status: number, code: string, message: string) => jsonRes(status, { error: { code, message } });

function deferred() {
  let resolve!: (res: Response) => void;
  const promise = new Promise<Response>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A login screen whose `GET /api/me` reads can be held open, mirroring a slow reconciliation. */
function fakeServer() {
  const reads: { release: () => void }[] = [];
  const state = { signedIn: false, logins: 0 };
  let gateReads = false;

  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.startsWith('/api/auth/providers')) return Promise.resolve(jsonRes(200, { local: true, providers: [] }));
      if (url === '/api/me') {
        // Decided at ISSUE time — a read taken before the cookie answers 401 however late it lands.
        const signedInAtIssue = state.signedIn;
        const answer = () =>
          signedInAtIssue ? jsonRes(200, { publicId: 'us_1' }) : fail(401, 'UNAUTHORIZED', 'not signed in');
        if (!gateReads) return Promise.resolve(answer());
        const gate = deferred();
        reads.push({ release: () => gate.resolve(answer()) });
        return gate.promise;
      }
      if (url.startsWith('/api/auth/local/')) {
        state.logins += 1;
        return Promise.resolve(fail(401, 'UNAUTHORIZED', 'Invalid email or password'));
      }
      throw new Error(`unstubbed fetch: ${init?.method ?? 'GET'} ${url}`);
    }),
  );
  return { reads, state, openReadGate: () => (gateReads = true) };
}

// Selected structurally, not by label: the submit's text becomes "…" while the attempt is pending
// and flips to "Create account" in signup mode, so a name-based query would miss it in exactly the
// window these rows are about. The mode switch's copy flips between the two directions.
const submit = () => document.querySelector<HTMLButtonElement>('button[type="submit"]')!;
const modeSwitch = () => screen.getByRole('button', { name: /(Need|Have) an account/ });

/**
 * Mirrors `App`, which mounts `useMe()` for the whole tab and renders `LoginPage` off its 401.
 * Required, not decorative: `invalidateQueries` refetches ACTIVE queries only, so without a mounted
 * observer the settlement reconciliation would issue no read at all and there would be no pending
 * window to assert against.
 */
function MeObserver() {
  useMe();
  return null;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('LoginPage — no control reopens the in-flight attempt window (#201 F2)', () => {
  /** Render the form and drive one failing attempt, leaving its reconciliation read held open. */
  async function attemptWithReadHeldOpen() {
    const user = userEvent.setup();
    const server = fakeServer();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MeObserver />
        <LoginPage />
      </QueryClientProvider>,
    );
    await screen.findByPlaceholderText('Email');
    await waitFor(() => expect(client.getQueryState(qk.me)?.status).toBe('error')); // the 401 has settled
    server.openReadGate();

    await user.type(screen.getByPlaceholderText('Email'), 'a@b.c');
    await user.type(screen.getByPlaceholderText('Password'), 'wrong');
    await user.click(submit());

    // Premise: the credentials POST has been answered and its settlement read is open and unsettled.
    await waitFor(() => expect(server.reads).toHaveLength(1));
    expect(client.getQueryState(qk.me)?.fetchStatus).toBe('fetching');
    return { user, server, client };
  }

  it('disables BOTH the submit and the mode switch while the reconciliation read is open', async () => {
    const { server } = await attemptWithReadHeldOpen();

    // The mode switch is the one F2 found: it calls `auth.reset()`, which detaches the observer from
    // the still-running mutation and republishes idle — re-enabling Submit mid-flight.
    expect(modeSwitch()).toBeDisabled();
    expect(submit()).toBeDisabled();

    // Both come back once the read settles, leaving the ordinary retry affordance intact.
    server.reads[0]!.release();
    await waitFor(() => expect(submit()).toBeEnabled());
    expect(modeSwitch()).toBeEnabled();
  });

  it('a click on the disabled mode switch cannot dispatch a second credentials POST', async () => {
    const { user, server } = await attemptWithReadHeldOpen();
    expect(server.state.logins).toBe(1);

    // Clicking through the guard is the behaviour that matters, not just the attribute: a disabled
    // button swallows the click, so the mode never flips and no reset detaches the observer.
    await user.click(modeSwitch());
    await act(async () => {});
    expect(modeSwitch()).toHaveTextContent(/Need an account/); // still on login — the mode never flipped
    expect(submit()).toBeDisabled();
    expect(server.state.logins).toBe(1); // still exactly the one attempt

    server.reads[0]!.release();
    await waitFor(() => expect(submit()).toBeEnabled());
    // …and afterwards the switch works normally, so the guard is scoped to the pending window.
    await user.click(modeSwitch());
    expect(submit()).toHaveTextContent('Create account');
  });

  it('surfaces the rejected attempt on the form once the read settles (unchanged)', async () => {
    const { server } = await attemptWithReadHeldOpen();

    server.reads[0]!.release();
    await waitFor(() => expect(screen.getByText('Invalid email or password')).toBeInTheDocument());
  });
});
