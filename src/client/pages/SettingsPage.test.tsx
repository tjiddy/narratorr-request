import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ConnectorSettingsDto } from '@shared/schemas/connectors';
import { SettingsPage } from './SettingsPage';

/**
 * Host-level wiring for the Settings shell (#143). Every picker behavior is covered against the
 * card directly in `SettingsKindleSender.test.tsx`; what CANNOT be covered there is the prop
 * chain that feeds it — `useConnectorSettings()` → `SettingsPage` → `NotifiersSection` →
 * `KindleSenderCard`. Passing `null`, or the wrong DTO field, at either hop leaves every direct
 * card test green while the real page shows a confirmed sender as unset. So this file renders the
 * page for real, off a stubbed `fetch`, and asserts the saved baseline survives both hops.
 */

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const CONNECTORS_URL = '/api/admin/settings/connectors';

const jsonRes = (status: number, payload: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(payload)),
  }) as unknown as Response;

const emailNotifier = (id: string, name: string, from: string) => ({
  id,
  name,
  type: 'email' as const,
  events: ['request.created' as const],
  config: { host: 'smtp.example.com', port: 587, secure: false, user: null, from, to: 'admin@ex.com', hasPassword: true },
});

const dto = (over: Partial<ConnectorSettingsDto> = {}): ConnectorSettingsDto => ({
  publicUrl: null,
  narratorr: null,
  notifiers: [emailNotifier('nf_1', 'Household SMTP', 'bot@ex.com')],
  defaultQuota: { mode: 'limited', limit: 10, windowDays: 30 },
  requesterEmailWarning: false,
  kindleSender: null,
  ebooksEnabled: false,
  ...over,
});

function installFetchStub(settings: ConnectorSettingsDto): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(CONNECTORS_URL)) return Promise.resolve(jsonRes(200, settings));
      throw new Error(`unstubbed fetch: ${url}`);
    }),
  );
}

/** Render the page and switch to the Notifications section (where the picker lives). */
async function openNotifications(settings: ConnectorSettingsDto) {
  installFetchStub(settings);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={client}>
      <SettingsPage />
    </QueryClientProvider>,
  );
  await user.click(await screen.findByRole('button', { name: 'Notifications' }));
  return user;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
beforeEach(() => {
  vi.clearAllMocks();
});

describe('SettingsPage → NotifiersSection → KindleSenderCard wiring (#143)', () => {
  it('threads a CONFIRMED saved sender all the way to the picker', async () => {
    await openNotifications(
      dto({ kindleSender: { notifierId: 'nf_1', confirmedFrom: 'Bot@Ex.com', status: 'ok', currentFrom: 'Bot@Ex.com' } }),
    );

    // The card sees the saved baseline: the ok block names the address to allowlist…
    expect(screen.getByText(/Approved Personal Document E-mail List/i)).toBeInTheDocument();
    expect(screen.getByText('Bot@Ex.com')).toBeInTheDocument();
    // …the draft seeds to the saved id, so there is nothing to save…
    expect((screen.getByLabelText('Kindle sender') as HTMLSelectElement).value).toBe('nf_1');
    expect(screen.queryByRole('button', { name: /save|reconfirm/i })).not.toBeInTheDocument();
    // …and the unset copy — what a dropped/nulled prop would render instead — is absent.
    expect(screen.queryByText(/Kindle delivery is unavailable/i)).not.toBeInTheDocument();
  });

  it('threads a FAULTY saved sender (status + currentFrom, not just the id) to the picker', async () => {
    // Pins the whole resolved object, not merely truthiness: forwarding a stripped or
    // re-derived value would lose the status-specific diagnosis and the live mailbox.
    await openNotifications(
      dto({
        notifiers: [emailNotifier('nf_1', 'Household SMTP', 'new@ex.com')],
        kindleSender: { notifierId: 'nf_1', confirmedFrom: 'bot@ex.com', status: 'sender-changed', currentFrom: 'new@ex.com' },
      }),
    );

    expect(screen.getByText(/now sends as new@ex\.com \(confirmed: bot@ex\.com\)/i)).toBeInTheDocument();
    expect(screen.getByText('Saved sender: “Household SMTP”.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reconfirm sender' })).toBeInTheDocument();
  });

  it('renders the unset state when the settings DTO genuinely carries no selection', async () => {
    // The negative half — without it, a card hard-wired to "unset" would pass the tests above's
    // absence assertions only by accident.
    await openNotifications(dto({ kindleSender: null }));

    expect(screen.getByText(/No Kindle sender is confirmed yet, so Kindle delivery is unavailable/i)).toBeInTheDocument();
    expect(screen.queryByText(/Approved Personal Document E-mail List/i)).not.toBeInTheDocument();
  });

  it('feeds the picker the SAME notifier list the section renders', async () => {
    await openNotifications(
      dto({
        notifiers: [emailNotifier('nf_1', 'Household SMTP', 'bot@ex.com'), emailNotifier('nf_2', 'Backup SMTP', 'backup@ex.com')],
        kindleSender: null,
      }),
    );

    const options = Array.from((screen.getByLabelText('Kindle sender') as HTMLSelectElement).options).map((o) => o.textContent);
    expect(options).toEqual(['No Kindle sender', 'Household SMTP — bot@ex.com', 'Backup SMTP — backup@ex.com']);
    // The same rows are listed below as notifier cards — one list, two consumers.
    expect(screen.getByRole('heading', { name: 'Household SMTP' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Backup SMTP' })).toBeInTheDocument();
  });
});

/**
 * Host-level wiring for the companion-ebook toggle (#144). The pure helpers in
 * `settings-ebooks.ts` prove init/dirty/payload logic, but they cannot prove that the page
 * actually RENDERS an accessible control, threads `data.ebooksEnabled` down to it, or submits the
 * body those helpers build — the same `useConnectorSettings() → SettingsPage → GeneralSection`
 * prop chain the Kindle-sender cases above cover for the Notifications section.
 */
describe('SettingsPage → GeneralSection → companion-ebook toggle (#144)', () => {
  /**
   * Render the page on the General section (where the toggle lives) and return the fetch spy.
   *
   * `holdPut` parks every PUT on a deferred the caller releases, so a test can observe the page
   * WHILE the request is in flight — the only way to exercise the Save button's pending lock.
   */
  async function openGeneral(settings: ConnectorSettingsDto, opts: { holdPut?: boolean } = {}) {
    const releases: Array<() => void> = [];
    // One authoritative row, as the server has: a PUT COMMITS into it and a subsequent GET (the
    // refetch every save triggers) serves the committed state. Echoing the request body back
    // without committing would let the post-save reseed disagree with what was written.
    const row: ConnectorSettingsDto = { ...settings };
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith(CONNECTORS_URL)) {
          if (init?.method === 'PUT') {
            Object.assign(row, JSON.parse(String(init.body)) as Partial<ConnectorSettingsDto>);
            const res = jsonRes(200, { ...row });
            if (!opts.holdPut) return Promise.resolve(res);
            return new Promise<Response>((resolve) => releases.push(() => resolve(res)));
          }
          return Promise.resolve(jsonRes(200, { ...row }));
        }
        throw new Error(`unstubbed fetch: ${url}`);
      }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={client}>
        <SettingsPage />
      </QueryClientProvider>,
    );
    // General is the default section; wait for the settings load to paint it.
    await screen.findByText('Companion eBooks');
    return {
      user,
      fetchMock: vi.mocked(globalThis.fetch),
      releaseAllPuts: () => releases.splice(0).forEach((r) => r()),
    };
  }

  /** The PUT bodies the page sent, in order. */
  const putBodies = (fetchMock: ReturnType<typeof vi.mocked<typeof globalThis.fetch>>): unknown[] =>
    fetchMock.mock.calls
      .filter(([, init]) => init?.method === 'PUT')
      .map(([, init]) => JSON.parse(String(init?.body)));

  it('renders an accessible control that is OFF by default, with no Save until it changes', async () => {
    await openGeneral(dto({ ebooksEnabled: false }));
    const toggle = screen.getByLabelText('Companion eBooks') as HTMLInputElement;
    expect(toggle).not.toBeChecked();
    // Per-card save: the button only appears once the card is dirty.
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('reflects a SAVED true — a dropped or hard-coded prop would render it off', async () => {
    await openGeneral(dto({ ebooksEnabled: true }));
    expect(screen.getByLabelText('Companion eBooks')).toBeChecked();
  });

  it('turning it ON submits exactly { ebooksEnabled: true }', async () => {
    const { user, fetchMock } = await openGeneral(dto({ ebooksEnabled: false }));
    await user.click(screen.getByLabelText('Companion eBooks'));
    await user.click(await screen.findByRole('button', { name: 'Save' }));

    await vi.waitFor(() => expect(putBodies(fetchMock)).toHaveLength(1));
    // ONLY the toggle: no sibling field, and no `narratorr` key (which would retire the server's
    // cached capability on every save).
    expect(putBodies(fetchMock)[0]).toEqual({ ebooksEnabled: true });
  });

  // F7 — `EbooksCard` wires `update.isPending` into `SaveButton`, but a test whose PUT resolves
  // immediately never observes the in-flight window: replacing `pending={update.isPending}` with
  // `pending={false}` would leave every other row green. These hold the request open instead.
  it('locks the Save button while the PUT is in flight, and a second click cannot double-write', async () => {
    const { user, fetchMock, releaseAllPuts } = await openGeneral(dto({ ebooksEnabled: false }), { holdPut: true });
    await user.click(screen.getByLabelText('Companion eBooks'));

    const save = await screen.findByRole('button', { name: 'Save' });
    await user.click(save);

    // In flight: the button reports busy (Button maps `loading` → `disabled`), so the browser
    // cannot dispatch another submit from it.
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled());
    expect(putBodies(fetchMock)).toHaveLength(1);

    // A second click during the lock must not reach the network.
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(putBodies(fetchMock)).toHaveLength(1);

    // …and the lock lifts once the request settles.
    releaseAllPuts();
    await vi.waitFor(() => expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument());
    expect(putBodies(fetchMock)).toHaveLength(1);
  });

  it('turning it OFF submits an EXPLICIT false, not an empty body', async () => {
    // The regression a truthiness-spread payload introduces: `{}` means "keep" on the server, so
    // the feature could never be turned back off while the UI reported a successful save.
    const { user, fetchMock } = await openGeneral(dto({ ebooksEnabled: true }));
    await user.click(screen.getByLabelText('Companion eBooks'));
    await user.click(await screen.findByRole('button', { name: 'Save' }));

    await vi.waitFor(() => expect(putBodies(fetchMock)).toHaveLength(1));
    expect(putBodies(fetchMock)[0]).toEqual({ ebooksEnabled: false });
  });
});
