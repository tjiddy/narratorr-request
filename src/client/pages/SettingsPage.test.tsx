import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ConnectorSettingsDto } from '@shared/schemas/connectors';
import { SettingsPage } from './SettingsPage';

/**
 * Host-level wiring for the Settings shell (#143, #144, reshaped by #193). Every picker behavior
 * is covered against the card directly in `SettingsKindleSender.test.tsx`; what CANNOT be covered
 * there is the prop chain that feeds it — `useConnectorSettings()` → `SettingsPage` →
 * `EbooksSection` → `KindleSenderCard`. Passing `null`, or the wrong DTO field, at either hop
 * leaves every direct card test green while the real page shows a confirmed sender as unset. So
 * this file renders the page for real, off a stubbed `fetch`, and asserts the saved baseline
 * survives both hops — plus #193's structural claims: the sender lives in the eBooks section
 * behind the enable toggle, and NOT on the Notifications page.
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

/** Render the page and switch to the named settings section. */
async function openSection(name: 'eBooks' | 'Notifications', settings: ConnectorSettingsDto) {
  installFetchStub(settings);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={client}>
      <SettingsPage />
    </QueryClientProvider>,
  );
  await user.click(await screen.findByRole('button', { name }));
  return user;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
beforeEach(() => {
  vi.clearAllMocks();
});

describe('SettingsPage → EbooksSection → KindleSenderCard wiring (#143/#193)', () => {
  // The sender is disclosed only when ebook support is SAVED on, so every wiring case
  // rides `ebooksEnabled: true`; the disclosure itself is pinned in the #193 block below.
  it('threads a CONFIRMED saved sender all the way to the picker', async () => {
    await openSection(
      'eBooks',
      dto({
        ebooksEnabled: true,
        kindleSender: { notifierId: 'nf_1', confirmedFrom: 'Bot@Ex.com', status: 'ok', currentFrom: 'Bot@Ex.com' },
      }),
    );

    // The card sees the saved baseline: the ok block renders its quiet users-allowlist note…
    expect(screen.getByText(/your users add this address/i)).toBeInTheDocument();
    // …the draft seeds to the saved id, so there is nothing to save…
    expect((screen.getByLabelText('Kindle sender') as HTMLSelectElement).value).toBe('nf_1');
    expect(screen.queryByRole('button', { name: /save|reconfirm/i })).not.toBeInTheDocument();
    // …and the unset copy — what a dropped/nulled prop would render instead — is absent.
    expect(screen.queryByText(/Kindle delivery is unavailable/i)).not.toBeInTheDocument();
  });

  it('threads a FAULTY saved sender (status + currentFrom, not just the id) to the picker', async () => {
    // Pins the whole resolved object, not merely truthiness: forwarding a stripped or
    // re-derived value would lose the status-specific diagnosis and the live mailbox.
    await openSection(
      'eBooks',
      dto({
        ebooksEnabled: true,
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
    await openSection('eBooks', dto({ ebooksEnabled: true, kindleSender: null }));

    expect(screen.getByText(/No Kindle sender is confirmed yet, so Kindle delivery is unavailable/i)).toBeInTheDocument();
    expect(screen.queryByText(/Approved Personal Document E-mail List/i)).not.toBeInTheDocument();
  });

  it('feeds the picker the notifier list the Notifications section owns', async () => {
    await openSection(
      'eBooks',
      dto({
        ebooksEnabled: true,
        notifiers: [emailNotifier('nf_1', 'Household SMTP', 'bot@ex.com'), emailNotifier('nf_2', 'Backup SMTP', 'backup@ex.com')],
        kindleSender: null,
      }),
    );

    const options = Array.from((screen.getByLabelText('Kindle sender') as HTMLSelectElement).options).map((o) => o.textContent);
    expect(options).toEqual(['No Kindle sender', 'Household SMTP — bot@ex.com', 'Backup SMTP — backup@ex.com']);
  });
});

describe('#193 — the eBooks section owns the toggle and the sender; Notifications does not', () => {
  it('hides the Kindle sender until ebook support is SAVED on (progressive disclosure)', async () => {
    await openSection(
      'eBooks',
      dto({
        ebooksEnabled: false,
        kindleSender: { notifierId: 'nf_1', confirmedFrom: 'bot@ex.com', status: 'ok', currentFrom: 'bot@ex.com' },
      }),
    );

    // The toggle renders; the sender — even a fully confirmed one — does not.
    expect(screen.getByRole('checkbox', { name: 'Enable ebook support' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Kindle sender')).not.toBeInTheDocument();
    expect(screen.queryByText(/Approved Personal Document E-mail List/i)).not.toBeInTheDocument();
  });

  it('no longer renders the Kindle sender on the Notifications page', async () => {
    await openSection(
      'Notifications',
      dto({
        ebooksEnabled: true,
        kindleSender: { notifierId: 'nf_1', confirmedFrom: 'bot@ex.com', status: 'ok', currentFrom: 'bot@ex.com' },
      }),
    );

    // The section still renders its own content (the notifier list)…
    expect(screen.getByRole('heading', { name: 'Household SMTP' })).toBeInTheDocument();
    // …but the sender picker and its allowlist block have moved out.
    expect(screen.queryByLabelText('Kindle sender')).not.toBeInTheDocument();
    expect(screen.queryByText(/Approved Personal Document E-mail List/i)).not.toBeInTheDocument();
  });

  it('keeps a CONSTANT toggle label in both states — the switch shows the state, not the label', async () => {
    await openSection('eBooks', dto({ ebooksEnabled: false }));
    const toggle = screen.getByRole('checkbox', { name: 'Enable ebook support' });
    expect(toggle).not.toBeChecked();

    // Flip the draft: the accessible name must not change (the old checkbox swapped
    // "Hidden from everyone" / "Available to approved users", which reads as an action).
    await userEvent.click(toggle);
    expect(screen.getByRole('checkbox', { name: 'Enable ebook support' })).toBeChecked();
    expect(screen.queryByText(/Hidden from everyone|Available to approved users/)).not.toBeInTheDocument();
  });
});

/**
 * Host-level wiring for the companion-ebook toggle (#144, relocated by #193). The pure helpers in
 * `settings-ebooks.ts` prove init/dirty/payload logic, but they cannot prove that the page
 * actually RENDERS an accessible control, threads `data.ebooksEnabled` down to it, or submits the
 * body those helpers build.
 */
describe('SettingsPage → EbooksSection → enable toggle (#144/#193)', () => {
  /**
   * Render the page, open the eBooks section, and return the fetch spy.
   *
   * `holdPut` parks every PUT on a deferred the caller releases, so a test can observe the page
   * WHILE the request is in flight — the only way to exercise the Save button's pending lock.
   */
  async function openEbooks(settings: ConnectorSettingsDto, opts: { holdPut?: boolean } = {}) {
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
    await user.click(await screen.findByRole('button', { name: 'eBooks' }));
    await screen.findByRole('checkbox', { name: 'Enable ebook support' });
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

  it('renders an accessible switch that is OFF by default, with no Save until it changes', async () => {
    await openEbooks(dto({ ebooksEnabled: false }));
    const toggle = screen.getByRole('checkbox', { name: 'Enable ebook support' }) as HTMLInputElement;
    expect(toggle).not.toBeChecked();
    // Per-card save: the button only appears once the card is dirty.
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('reflects a SAVED true — a dropped or hard-coded prop would render it off', async () => {
    await openEbooks(dto({ ebooksEnabled: true }));
    expect(screen.getByRole('checkbox', { name: 'Enable ebook support' })).toBeChecked();
  });

  it('turning it ON submits exactly { ebooksEnabled: true }', async () => {
    const { user, fetchMock } = await openEbooks(dto({ ebooksEnabled: false }));
    await user.click(screen.getByRole('checkbox', { name: 'Enable ebook support' }));
    await user.click(await screen.findByRole('button', { name: 'Save' }));

    await vi.waitFor(() => expect(putBodies(fetchMock)).toHaveLength(1));
    // ONLY the toggle: no sibling field, and no `narratorr` key (which would retire the server's
    // cached capability on every save).
    expect(putBodies(fetchMock)[0]).toEqual({ ebooksEnabled: true });
  });

  it('locks the Save button while the PUT is in flight, and a second click cannot double-write', async () => {
    // notifiers: [] — once the save commits, disclosure reveals the sender card, and with an
    // eligible notifier present its form-only preselect surfaces a SECOND Save button (#143
    // behavior, pinned in SettingsKindleSender.test.tsx). This test is about the toggle card's
    // lock, so keep the sender card save-less.
    const { user, fetchMock, releaseAllPuts } = await openEbooks(
      dto({ ebooksEnabled: false, notifiers: [] }),
      { holdPut: true },
    );
    await user.click(screen.getByRole('checkbox', { name: 'Enable ebook support' }));

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
    // notifiers: [] — the disclosed sender card would otherwise contribute its own preselect
    // Save button (#143) and make the name query ambiguous.
    const { user, fetchMock } = await openEbooks(dto({ ebooksEnabled: true, notifiers: [] }));
    await user.click(screen.getByRole('checkbox', { name: 'Enable ebook support' }));
    await user.click(await screen.findByRole('button', { name: 'Save' }));

    await vi.waitFor(() => expect(putBodies(fetchMock)).toHaveLength(1));
    expect(putBodies(fetchMock)[0]).toEqual({ ebooksEnabled: false });
  });

  it('reveals the Kindle sender after the save commits and the refetch returns enabled', async () => {
    // The full disclosure round-trip: OFF (no sender) → toggle + save → the committed row comes
    // back enabled → the sender card appears without a reload.
    const { user } = await openEbooks(dto({ ebooksEnabled: false, kindleSender: null }));
    expect(screen.queryByLabelText('Kindle sender')).not.toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: 'Enable ebook support' }));
    await user.click(await screen.findByRole('button', { name: 'Save' }));

    await vi.waitFor(() => expect(screen.getByLabelText('Kindle sender')).toBeInTheDocument());
  });
});
