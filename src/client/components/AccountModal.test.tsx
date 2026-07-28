import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MeDto } from '@shared/schemas/user';
import { useMe } from '../hooks';
import { KINDLE_EMAIL_HELP } from '../pages/notify-prefs';
import { AccountModal } from './AccountModal';

// The hook toasts on every settled mutation; the toasts are not what this file is about (they're
// covered by `meSuccessToast`'s pure tests), and a real sonner store would leak between cases.
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

/**
 * DOM-only coverage for the account modal's Kindle-address row (#142). Deliberately scoped to what
 * can't be a pure function: which Save the click reaches, what body that Save puts on the wire, which
 * row shows an error, and whether the two rows' pending states are independent. The dirty/patch/
 * reconcile/toast DECISIONS stay in `notify-prefs.test.ts` (frontend-logic-extract-not-jsdom).
 *
 * `EmptyState.test.tsx` is prop-only and is NOT a template for this: `AccountModal` renders through
 * `Dialog` (a `createPortal` to `<body>`) and calls `useUpdateMe` / `useAuthProviders`, so it needs a
 * `QueryClientProvider` and a `fetch` stub. The harness lives here rather than under
 * `src/client/test/` because it is, so far, the only test that needs it.
 */

const baseMe: MeDto = {
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

/** A minimal stand-in for the bits of `Response` that `api.ts`'s `parse()` actually reads. */
const jsonRes = (status: number, payload: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(payload)),
  }) as unknown as Response;

type PatchBody = Record<string, unknown>;

/** Every PATCH /api/me body the component put on the wire, in order. */
let patchBodies: PatchBody[];
/** The current server-side MeDto — GET /api/me reads it, the default PATCH responder updates it. */
let serverMe: MeDto;
/** Per-test override for how a PATCH resolves. Default: apply it the way the server would. */
let patchResponder: (body: PatchBody) => Promise<Response>;

/** What the server does to an address before storing it: trim + lowercase (`kindleEmailSchema`). */
const normalize = (value: unknown): string | null =>
  typeof value === 'string' ? value.trim().toLowerCase() : null;

const applyPatch = async (body: PatchBody): Promise<Response> => {
  const next: MeDto = { ...serverMe };
  if ('email' in body) next.email = normalize(body['email']);
  if ('kindleEmail' in body) next.kindleEmail = normalize(body['kindleEmail']);
  serverMe = next;
  return jsonRes(200, serverMe);
};

function installFetchStub(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/auth/providers')) return Promise.resolve(jsonRes(200, { local: true, providers: [] }));
      if (url.startsWith('/api/me')) {
        if (init?.method === 'PATCH') {
          const body = JSON.parse(String(init.body)) as PatchBody;
          patchBodies.push(body);
          return patchResponder(body);
        }
        return Promise.resolve(jsonRes(200, serverMe));
      }
      throw new Error(`unstubbed fetch: ${url}`);
    }),
  );
}

/** Mirrors `Layout.tsx`: `me` comes from the `useMe()` cache, which `useUpdateMe` writes on success —
 *  so a save's returned DTO reaches the component as a prop, exactly as it does in the app. */
function Harness() {
  const { data: me } = useMe();
  if (!me) return null;
  return <AccountModal me={me} open onClose={() => {}} />;
}

async function renderModal(me: Partial<MeDto> = {}) {
  serverMe = { ...baseMe, ...me };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
  await screen.findByLabelText('Kindle address');
}

const kindleInput = () => screen.getByLabelText('Kindle address') as HTMLInputElement;
const kindleSave = () => screen.getByRole('button', { name: 'Save Kindle address' });
const emailInput = () => screen.getByLabelText('Email') as HTMLInputElement;
const emailSave = () => screen.getByRole('button', { name: 'Save email' });

beforeEach(() => {
  patchBodies = [];
  patchResponder = applyPatch;
  installFetchStub();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('AccountModal — Kindle address row (#142)', () => {
  it('renders the field empty for a user who has never set one, with the helper copy', async () => {
    await renderModal({ kindleEmail: null });

    expect(kindleInput().value).toBe('');
    expect(screen.getByText(KINDLE_EMAIL_HELP)).toBeInTheDocument();
    expect(screen.getByText(/Amazon: Devices > your Kindle > Email/)).toBeInTheDocument();
  });

  it('seeds the field from me.kindleEmail', async () => {
    await renderModal({ kindleEmail: 'device@kindle.com' });

    expect(kindleInput().value).toBe('device@kindle.com');
  });

  it('its Save is disabled at rest and enables on edit', async () => {
    const user = userEvent.setup();
    await renderModal({ kindleEmail: 'device@kindle.com' });

    expect(kindleSave()).toBeDisabled();
    await user.type(kindleInput(), 'x');
    expect(kindleSave()).toBeEnabled();
  });

  it('saving sends a PATCH carrying ONLY kindleEmail — never the contact email', async () => {
    const user = userEvent.setup();
    await renderModal({ kindleEmail: null, email: 'todd@example.com' });

    await user.type(kindleInput(), 'device@kindle.com');
    await user.click(kindleSave());

    await waitFor(() => expect(patchBodies).toHaveLength(1));
    // Exact equality: an `email` riding along (or any other key) fails here.
    expect(patchBodies[0]).toEqual({ kindleEmail: 'device@kindle.com' });
  });

  it('clearing the field and saving sends kindleEmail: null (the clear sentinel, never "")', async () => {
    const user = userEvent.setup();
    await renderModal({ kindleEmail: 'device@kindle.com' });

    await user.clear(kindleInput());
    await user.click(kindleSave());

    await waitFor(() => expect(patchBodies).toHaveLength(1));
    expect(patchBodies[0]).toEqual({ kindleEmail: null });
    await waitFor(() => expect(kindleInput().value).toBe(''));
  });

  // F3: the pure reconciler's invariant is proven in notify-prefs.test.ts; this proves the component
  // actually WIRES it for this row. Without the onSuccess callback the input keeps the mixed-case
  // draft and its Save stays visibly dirty after a successful save.
  it('adopts the server-normalized value after a mixed-case save, leaving Save clean', async () => {
    const user = userEvent.setup();
    await renderModal({ kindleEmail: null });

    await user.type(kindleInput(), 'Device@KINDLE.COM');
    await user.click(kindleSave());

    await waitFor(() => expect(kindleInput().value).toBe('device@kindle.com'));
    expect(kindleSave()).toBeDisabled();
  });

  it('surfaces a rejected save inline on the Kindle row, not the contact-email row', async () => {
    const user = userEvent.setup();
    patchResponder = () =>
      Promise.resolve(jsonRes(400, { error: { code: 'FST_ERR_VALIDATION', message: 'enter your Kindle address' } }));
    await renderModal({ kindleEmail: null });

    await user.type(kindleInput(), 'nope@example.com');
    await user.click(kindleSave());

    const error = await screen.findByText('enter your Kindle address');
    // The error replaced the KINDLE row's helper copy; the contact row's is untouched.
    expect(screen.queryByText(KINDLE_EMAIL_HELP)).not.toBeInTheDocument();
    expect(screen.getByText('Where notifications are sent.')).toBeInTheDocument();
    // And it is rendered inside the KINDLE row's own container, not the contact row's. (Each row is
    // `<div><div class="flex items-end">…input…</div><p>error|help</p></div>`, so the input's nearest
    // div is the field line and its parent is the row wrapper.)
    const kindleRow = kindleInput().closest('div')?.parentElement;
    const emailRow = emailInput().closest('div')?.parentElement;
    expect(kindleRow).toContainElement(error);
    expect(emailRow).not.toContainElement(error);
  });

  // F5 disposition: the rows hold INDEPENDENT mutation instances, so an in-flight contact save must
  // not disable a dirty Kindle Save. A single shared `useUpdateMe` would fail this.
  it('an in-flight contact save does not disable the Kindle Save', async () => {
    const user = userEvent.setup();
    let releaseContactSave = (): void => {};
    patchResponder = (body) =>
      'email' in body
        ? new Promise<Response>((resolve) => {
            releaseContactSave = () => resolve(jsonRes(200, serverMe));
          })
        : applyPatch(body);
    await renderModal({ kindleEmail: null });

    await user.type(kindleInput(), 'device@kindle.com');
    await user.type(emailInput(), 'x');
    await user.click(emailSave());

    await waitFor(() => expect(emailSave()).toBeDisabled()); // the contact row is locked mid-flight
    expect(kindleSave()).toBeEnabled(); // …the Kindle row is not

    releaseContactSave();
    await waitFor(() => expect(patchBodies).toHaveLength(1));
  });
});
