import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MeDto } from '@shared/schemas/user';
import { useMe } from '../hooks';
import { KINDLE_EMAIL_HELP } from '../pages/notify-prefs';
import { AccountModal } from './AccountModal';
import {
  AMAZON_APPROVED_LIST_URL,
  AMAZON_APPROVED_LIST_LINK_LABEL,
  AMAZON_APPROVED_LIST_DISCLOSURE_LABEL,
} from './kindle-allowlist';

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

  // F2: the row's OWN pending lock. The test above only proves the Kindle Save survives the SIBLING
  // row's in-flight save — `pending={false}` would leave it green. This one holds the Kindle request
  // open and asserts its own button locks, so a regression to a constant is caught.
  it('disables its own Save while its PATCH is in flight, and a second click cannot duplicate it', async () => {
    const user = userEvent.setup();
    let releaseKindleSave = (): void => {};
    patchResponder = (body) =>
      new Promise<Response>((resolve) => {
        releaseKindleSave = () => resolve(jsonRes(200, { ...serverMe, kindleEmail: normalize(body['kindleEmail']) }));
      });
    await renderModal({ kindleEmail: null });

    await user.type(kindleInput(), 'device@kindle.com');
    await user.click(kindleSave());

    await waitFor(() => expect(patchBodies).toHaveLength(1));
    await waitFor(() => expect(kindleSave()).toBeDisabled()); // locked by its own in-flight request
    // A second click while pending must not dispatch a duplicate PATCH.
    await user.click(kindleSave());
    expect(patchBodies).toHaveLength(1);

    releaseKindleSave();
    await waitFor(() => expect(kindleInput().value).toBe('device@kindle.com'));
    expect(patchBodies).toHaveLength(1);
  });

  // F3: the recovery chain after a rejection. The rejection test above stops at the error appearing,
  // so both recovery transitions (edit clears the error, a corrected retry reconciles and goes clean)
  // are unasserted — deleting the `setKindleError(null)` in onChange would still pass.
  it('clears the inline error on edit and returns to a clean state after a corrected retry', async () => {
    const user = userEvent.setup();
    let reject = true;
    patchResponder = (body) =>
      reject
        ? Promise.resolve(
            jsonRes(400, { error: { code: 'FST_ERR_VALIDATION', message: 'enter your Kindle address' } }),
          )
        : applyPatch(body);
    await renderModal({ kindleEmail: null });

    await user.type(kindleInput(), 'nope@example.com');
    await user.click(kindleSave());
    await screen.findByText('enter your Kindle address');

    // 1. Editing the field clears the stale error and restores the helper copy.
    await user.type(kindleInput(), 'x');
    expect(screen.queryByText('enter your Kindle address')).not.toBeInTheDocument();
    expect(screen.getByText(KINDLE_EMAIL_HELP)).toBeInTheDocument();

    // 2. A corrected retry succeeds, reconciles to the normalized value, and leaves Save clean.
    reject = false;
    await user.clear(kindleInput());
    await user.type(kindleInput(), 'Device@KINDLE.COM');
    await user.click(kindleSave());

    await waitFor(() => expect(kindleInput().value).toBe('device@kindle.com'));
    expect(kindleSave()).toBeDisabled();
    expect(screen.queryByText('enter your Kindle address')).not.toBeInTheDocument();
    expect(screen.getByText(KINDLE_EMAIL_HELP)).toBeInTheDocument();
  });
});

// F1: the two rows hold independent mutation instances (the F5 disposition), so their PATCHes can
// overlap — and every `useUpdateMe` success replaces the WHOLE `qk.me` entry with its own response
// DTO. Each response is a snapshot of the row as the server read it, so a request that started
// earlier carries the sibling field's PRE-write value; if it settles LAST it overwrites the newer
// sibling save in the cache, and that row goes falsely dirty (its draft holds the saved value while
// `me` claims the old one). These drive both orderings against frozen response snapshots.
describe('AccountModal — overlapping row saves settle race-safely (#142 F1)', () => {
  /** Start both saves, then settle them in the given order with snapshots frozen at dispatch time. */
  async function overlapSaves(settle: 'kindle-last' | 'contact-last') {
    const user = userEvent.setup();
    const release: Record<string, () => void> = {};
    patchResponder = (body) =>
      new Promise<Response>((resolve) => {
        // Frozen at DISPATCH: each response echoes the row as the server saw it for that request —
        // its own field written, the sibling still at its pre-overlap value. This is exactly what
        // two concurrent PATCH /api/me round-trips return.
        const snapshot: MeDto = {
          ...baseMe,
          email: 'email' in body ? normalize(body['email']) : baseMe.email,
          kindleEmail: 'kindleEmail' in body ? normalize(body['kindleEmail']) : baseMe.kindleEmail,
        };
        release['email' in body ? 'contact' : 'kindle'] = () => resolve(jsonRes(200, snapshot));
      });
    await renderModal({ email: 'todd@example.com', kindleEmail: null });

    await user.clear(emailInput());
    await user.type(emailInput(), 'new@contact.com');
    await user.clear(kindleInput());
    await user.type(kindleInput(), 'device@kindle.com');
    await user.click(emailSave());
    await user.click(kindleSave());
    await waitFor(() => expect(patchBodies).toHaveLength(2));

    // Settle the two in-flight responses in the requested order, letting each drain fully before
    // releasing the next so the ordering under test is deterministic.
    const order = settle === 'kindle-last' ? ['contact', 'kindle'] : ['kindle', 'contact'];
    for (const which of order) {
      release[which]?.();
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }
  }

  it('keeps both saved values when the contact response settles last', async () => {
    await overlapSaves('contact-last');

    // The contact response carried the PRE-overlap kindleEmail (null). Settling last must not undo
    // the Kindle save: both drafts hold their saved values and neither Save is falsely dirty.
    await waitFor(() => expect(emailInput().value).toBe('new@contact.com'));
    expect(kindleInput().value).toBe('device@kindle.com');
    expect(kindleSave()).toBeDisabled();
    expect(emailSave()).toBeDisabled();
  });

  it('keeps both saved values when the Kindle response settles last', async () => {
    await overlapSaves('kindle-last');

    // Mirror case: the Kindle response carried the pre-overlap email.
    await waitFor(() => expect(kindleInput().value).toBe('device@kindle.com'));
    expect(emailInput().value).toBe('new@contact.com');
    expect(emailSave()).toBeDisabled();
    expect(kindleSave()).toBeDisabled();
  });
});

// --- The Amazon allowlist education beside the Kindle row (#149 AC18/AC19) ----

describe('AccountModal — Amazon allowlist education (#149)', () => {
  const link = () => screen.queryByRole('link', { name: AMAZON_APPROVED_LIST_LINK_LABEL });
  const expander = () => screen.queryByRole('button', { name: AMAZON_APPROVED_LIST_DISCLOSURE_LABEL });

  it.each([
    ['an address already saved', 'device@kindle.com'],
    // The SETUP-time teaching moment: it must be there before there is anything to teach about.
    ['no address saved yet', null],
  ])('renders the link and the expander with %s', async (_label, kindleEmail) => {
    await renderModal({ kindleEmail });

    expect(link()).toBeInTheDocument();
    expect(expander()).toBeInTheDocument();
  });

  it('renders them beside the KINDLE row, not the contact-email row', async () => {
    await renderModal({ kindleEmail: null });

    // Each row is `<div><div class="flex items-end">…input…</div><p>error|help</p></div>`; the
    // education is a sibling of that row inside a shared wrapper.
    const kindleGroup = kindleInput().closest('div')?.parentElement?.parentElement;
    const emailRow = emailInput().closest('div')?.parentElement;
    expect(kindleGroup).toContainElement(link());
    expect(kindleGroup).toContainElement(expander());
    expect(emailRow).not.toContainElement(link());
  });

  it('opens the deep link in a new tab with both rel tokens', async () => {
    await renderModal({ kindleEmail: null });

    expect(link()).toHaveAttribute('href', AMAZON_APPROVED_LIST_URL);
    expect(link()).toHaveAttribute('target', '_blank');
    expect(link()!.getAttribute('rel')).toContain('noopener');
    expect(link()!.getAttribute('rel')).toContain('noreferrer');
  });

  it('keeps the click path collapsed by default and reveals it on demand', async () => {
    const user = userEvent.setup();
    await renderModal({ kindleEmail: null });

    expect(expander()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Personal Document Settings')).toBeNull();

    await user.click(expander()!);

    expect(expander()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Approved Personal Document E-mail List')).toBeInTheDocument();
    expect(screen.getByText('Enter the sender mailbox')).toBeInTheDocument();
    expect(screen.getByText(/one-time setup per Amazon account/i)).toBeInTheDocument();
  });

  // THE regression AC18 exists to prevent. `EmailFieldRow.help` is a `string` rendered only while
  // the row's inline `error` is null, so education routed through it would VANISH exactly when the
  // user has just failed to save an address — the moment they most need to be told about Amazon's
  // approved list. A `help`-prop implementation passes every other test in this describe.
  it('SURVIVES the row’s inline error state', async () => {
    const user = userEvent.setup();
    patchResponder = () =>
      Promise.resolve(jsonRes(400, { error: { code: 'FST_ERR_VALIDATION', message: 'enter your Kindle address' } }));
    await renderModal({ kindleEmail: null });

    await user.type(kindleInput(), 'nope@example.com');
    await user.click(kindleSave());
    await screen.findByText('enter your Kindle address');

    // The help copy is gone (the existing error/help swap, untouched) — the education is not.
    expect(screen.queryByText(KINDLE_EMAIL_HELP)).not.toBeInTheDocument();
    expect(link()).toBeInTheDocument();
    expect(expander()).toBeInTheDocument();
  });

  it('leaves the existing help/error swap exactly as it was', async () => {
    const user = userEvent.setup();
    let reject = true;
    patchResponder = (body) =>
      reject
        ? Promise.resolve(jsonRes(400, { error: { code: 'FST_ERR_VALIDATION', message: 'enter your Kindle address' } }))
        : applyPatch(body);
    await renderModal({ kindleEmail: null });

    // No error → the help copy renders.
    expect(screen.getByText(KINDLE_EMAIL_HELP)).toBeInTheDocument();

    await user.type(kindleInput(), 'nope@example.com');
    await user.click(kindleSave());
    await screen.findByText('enter your Kindle address');
    expect(screen.queryByText(KINDLE_EMAIL_HELP)).not.toBeInTheDocument();

    // …and it comes back once the error clears.
    reject = false;
    await user.type(kindleInput(), 'x');
    expect(screen.getByText(KINDLE_EMAIL_HELP)).toBeInTheDocument();
  });

  // The AC9 exemption, pinned deliberately: the SHEET must never show the full address, but this
  // input is where the user reads and edits it — masking here would break the feature.
  it('still renders the FULL Kindle address in its editable input', async () => {
    await renderModal({ kindleEmail: 'todd@kindle.com' });

    expect(kindleInput().value).toBe('todd@kindle.com');
    expect(kindleInput().value).not.toContain('…');
  });
});
