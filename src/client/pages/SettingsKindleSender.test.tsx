import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  ConnectorSettingsDto,
  NotifierDto,
  ResolvedKindleSender,
  KindleSenderStatus,
} from '@shared/schemas/connectors';
import { KindleSenderCard } from './SettingsKindleSender';

/**
 * DOM-only coverage for the Kindle-sender picker (#143). Every DECISION it makes (eligibility,
 * seeding/rebase, intent, payload build) is unit-tested in `settings-kindle-sender.test.ts`; this
 * file covers what can't be a pure function — the status-dependent rendering, the refetch-driven
 * draft rebase, and the save path.
 *
 * The save path runs through the REAL `useUpdateKindleSender` against a `fetch` stub (the
 * `AccountModal.test.tsx` harness), not a stubbed hook: what has to be pinned is which request the
 * click actually puts on the wire and that an in-flight save locks the control. A mocked hook
 * would let the mutation drop or rewrite the selection with every assertion here still green.
 */

// The hook toasts on every settled mutation; the toast text is asserted in `hooks.test.ts`, and a
// real sonner store would leak between cases.
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const CONNECTORS_URL = '/api/admin/settings/connectors';

const emailRow = (id: string, from = 'bot@ex.com', name = `Mail ${id}`): NotifierDto => ({
  id,
  name,
  type: 'email',
  events: ['request.created'],
  config: { host: 'smtp.example.com', port: 587, secure: false, user: null, from, to: 'a@ex.com', hasPassword: true },
});
// What `toNotifierDto()` emits for a known email row whose config fails masking: raw type
// 'email', but degraded — no `config`, so no `from` the server could ever confirm.
const degradedEmailRow = (id: string, name = `Broken ${id}`): NotifierDto => ({
  id,
  name,
  type: 'email',
  events: ['request.created'],
  unknown: true,
});
const ntfyRow = (id: string, name = `Phone ${id}`): NotifierDto => ({
  id,
  name,
  type: 'ntfy',
  events: ['request.created'],
  config: { url: 'https://ntfy.sh', topic: 't', hasToken: false, priority: null },
});

const saved = (status: KindleSenderStatus, over: Partial<ResolvedKindleSender> = {}): ResolvedKindleSender => ({
  notifierId: 'nf_1',
  confirmedFrom: 'bot@ex.com',
  status,
  currentFrom: status === 'ok' ? 'bot@ex.com' : status === 'sender-changed' ? 'new@ex.com' : null,
  ...over,
});

const baseDto: ConnectorSettingsDto = {
  publicUrl: null,
  narratorr: null,
  notifiers: [],
  defaultQuota: { mode: 'limited', limit: 10, windowDays: 30 },
  requesterEmailWarning: false,
  kindleSender: null,
};

/** A minimal stand-in for the bits of `Response` that `api.ts`'s `parse()` actually reads. */
const jsonRes = (status: number, payload: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(payload)),
  }) as unknown as Response;

/** Every PUT /api/admin/settings/connectors body the card put on the wire, in order. */
let putBodies: Record<string, unknown>[];
/** Per-test override for how the PUT resolves. Default: an immediate 200. */
let putResponder: () => Promise<Response>;

function installFetchStub(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith(CONNECTORS_URL)) {
        if (init?.method === 'PUT') {
          putBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
          return putResponder();
        }
        return Promise.resolve(jsonRes(200, baseDto));
      }
      throw new Error(`unstubbed fetch: ${url}`);
    }),
  );
}

interface CardProps {
  notifiers: NotifierDto[];
  saved: ResolvedKindleSender | null;
}

function renderCard(props: CardProps) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const tree = (p: CardProps) => (
    <QueryClientProvider client={client}>
      <KindleSenderCard notifiers={p.notifiers} saved={p.saved} />
    </QueryClientProvider>
  );
  const view = render(tree(props));
  // Re-render the SAME mounted card with new props — the notifier-CRUD refetch case. The card is
  // not keyed/remounted by its parent, so this is the real lifecycle it has to survive.
  return { ...view, rerenderCard: (next: CardProps) => view.rerender(tree(next)) };
}

const picker = () => screen.getByLabelText('Kindle sender') as HTMLSelectElement;
const optionLabels = () => Array.from(picker().options).map((o) => o.textContent);
const saveButton = () => screen.queryByRole('button', { name: /save|reconfirm/i });

/** Wait for the card's save to reach the wire, then assert the exact bodies sent. */
const expectPut = async (...bodies: unknown[]) => {
  await waitFor(() => expect(putBodies).toHaveLength(bodies.length));
  expect(putBodies).toEqual(bodies);
};

// The imperative row instructions AC22 forbids. The identity rule legitimately MENTIONS
// recreating a notifier when explaining that a replacement needs a save here — what must never
// appear is a directive to go act on a row, so match the instruction, not the words.
const ROW_INSTRUCTIONS = [/edit (this|that) notifier/i, /delete and recreate/i, /recreate it below/i];

beforeEach(() => {
  putBodies = [];
  putResponder = () => Promise.resolve(jsonRes(200, baseDto));
  installFetchStub();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('KindleSenderCard — options + Save affordance', () => {
  it('renders only ELIGIBLE email notifiers plus a "none" option', () => {
    renderCard({ notifiers: [emailRow('nf_1'), degradedEmailRow('nf_bad'), ntfyRow('nf_n')], saved: null });

    expect(optionLabels()).toEqual(['No Kindle sender', 'Mail nf_1 — bot@ex.com']);
  });

  it('hides Save in both noop states (nothing saved + nothing picked, and an ok same-id draft)', () => {
    const { unmount } = renderCard({ notifiers: [emailRow('nf_1'), emailRow('nf_2')], saved: null });
    expect(picker().value).toBe(''); // two eligible ⇒ no preselect
    expect(saveButton()).not.toBeInTheDocument();
    unmount();

    renderCard({ notifiers: [emailRow('nf_1')], saved: saved('ok') });
    expect(picker().value).toBe('nf_1');
    expect(saveButton()).not.toBeInTheDocument();
  });

  it('preselects a SOLE eligible option and offers an enabled Save that persists it (never auto-saves)', async () => {
    const user = userEvent.setup();
    renderCard({ notifiers: [emailRow('nf_1')], saved: null });

    expect(picker().value).toBe('nf_1');
    expect(putBodies).toEqual([]); // seeding persists nothing

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await expectPut({ kindleSender: { notifierId: 'nf_1' } });
  });

  it('selecting a different eligible option yields a Save that persists that id', async () => {
    const user = userEvent.setup();
    renderCard({ notifiers: [emailRow('nf_1'), emailRow('nf_2')], saved: saved('ok') });

    await user.selectOptions(picker(), 'nf_2');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await expectPut({ kindleSender: { notifierId: 'nf_2' } });
  });

  it('selecting "none" clears when something is saved, and is inert when nothing is', async () => {
    const user = userEvent.setup();
    const { unmount } = renderCard({ notifiers: [emailRow('nf_1')], saved: saved('ok') });
    await user.selectOptions(picker(), '');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await expectPut({ kindleSender: null });
    unmount();
    putBodies = [];

    renderCard({ notifiers: [emailRow('nf_1')], saved: null });
    await user.selectOptions(picker(), ''); // deselect the preselected sole option
    expect(saveButton()).not.toBeInTheDocument();
    expect(putBodies).toEqual([]);
  });

  // The submit lock: without `loading={update.isPending}` the control stays live through the
  // round-trip and a second click writes the selector twice.
  it('locks the submit control while the save is in flight, so a second click sends nothing', async () => {
    const user = userEvent.setup();
    let release: (() => void) | undefined;
    putResponder = () => new Promise<Response>((resolve) => { release = () => resolve(jsonRes(200, baseDto)); });

    renderCard({ notifiers: [emailRow('nf_1')], saved: null });
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(saveButton()).toBeDisabled());
    await user.click(saveButton()!); // the in-flight control must refuse it
    expect(putBodies).toHaveLength(1);

    release!();
    await waitFor(() => expect(saveButton()).toBeEnabled());
    expect(putBodies).toHaveLength(1);
  });
});

describe('KindleSenderCard — the status matrix', () => {
  it('unset: states that Kindle delivery is unavailable', () => {
    renderCard({ notifiers: [emailRow('nf_1'), emailRow('nf_2')], saved: null });

    expect(screen.getByText(/No Kindle sender is confirmed yet, so Kindle delivery is unavailable/i)).toBeInTheDocument();
  });

  it('unset copy is gone once a sender is confirmed', () => {
    renderCard({ notifiers: [emailRow('nf_1')], saved: saved('ok') });

    expect(screen.queryByText(/Kindle delivery is unavailable/i)).not.toBeInTheDocument();
  });

  it('ok: shows the exact address to allowlist at Amazon, and no Save', () => {
    renderCard({ notifiers: [emailRow('nf_1')], saved: saved('ok') });

    expect(screen.getByText(/Approved Personal Document E-mail List/i)).toBeInTheDocument();
    expect(screen.getByText('bot@ex.com')).toBeInTheDocument();
    expect(saveButton()).not.toBeInTheDocument();
  });

  it('sender-changed: shows currentFrom + the confirmed address, and a SAME-ID reconfirm Save', async () => {
    const user = userEvent.setup();
    renderCard({ notifiers: [emailRow('nf_1', 'new@ex.com')], saved: saved('sender-changed') });

    expect(screen.getByText(/now sends as new@ex.com \(confirmed: bot@ex.com\)/i)).toBeInTheDocument();
    expect(picker().value).toBe('nf_1'); // the saved id is still eligible, so it seeds the draft

    await user.click(screen.getByRole('button', { name: 'Reconfirm sender' }));
    await expectPut({ kindleSender: { notifierId: 'nf_1' } });
  });

  it('from-unparseable: diagnoses the From and offers NO same-id Save (it would be a guaranteed 400)', () => {
    // The row is still eligible (a string `from`), so the draft seeds to it — but the intent is
    // noop, because AC8 rejects a same-id write outside sender-changed.
    renderCard({ notifiers: [emailRow('nf_1', 'ops team')], saved: saved('from-unparseable') });

    expect(screen.getByText(/not a single valid mailbox/i)).toBeInTheDocument();
    expect(picker().value).toBe('nf_1');
    expect(saveButton()).not.toBeInTheDocument();
  });

  it.each([
    ['config-unusable' as const, /stored SMTP config is unreadable/i, [degradedEmailRow('nf_1')]],
    ['not-email' as const, /no longer an email notifier/i, [ntfyRow('nf_1')]],
    ['notifier-missing' as const, /no longer exists/i, [] as NotifierDto[]],
  ])('%s: diagnoses the fault with NO draft selected — the only Save on offer is a clear', async (status, copy, notifiers) => {
    const user = userEvent.setup();
    renderCard({ notifiers, saved: saved(status) });

    expect(screen.getByText(copy)).toBeInTheDocument();
    expect(picker().value).toBe(''); // an ineligible saved id never enters the picker…

    // …so the Save that renders is the CLEAR intent, never a same-id write (which AC8 would 400).
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await expectPut({ kindleSender: null });
  });

  // AC22: the diagnosis has to tell the admin WHICH notifier is at fault, not just that one is.
  it.each([
    ['sender-changed' as const, [emailRow('nf_1', 'new@ex.com', 'Household SMTP')], 'Household SMTP'],
    ['from-unparseable' as const, [emailRow('nf_1', 'ops team', 'Household SMTP')], 'Household SMTP'],
    ['config-unusable' as const, [degradedEmailRow('nf_1', 'Household SMTP')], 'Household SMTP'],
    ['not-email' as const, [ntfyRow('nf_1', 'Household SMTP')], 'Household SMTP'],
  ])('%s: names the saved notifier so the admin can find the faulty row', (status, notifiers, name) => {
    renderCard({ notifiers, saved: saved(status) });

    expect(screen.getByText(`Saved sender: “${name}”.`)).toBeInTheDocument();
  });

  it('notifier-missing: identifies the dead sender by its confirmed address (there is no row left to name)', () => {
    renderCard({ notifiers: [emailRow('nf_other', 'other@ex.com')], saved: saved('notifier-missing') });

    expect(screen.getByText(/The notifier that sent as bot@ex\.com no longer exists/i)).toBeInTheDocument();
    expect(screen.queryByText(/^Saved sender: /)).not.toBeInTheDocument();
  });

  it.each(['sender-changed', 'from-unparseable', 'config-unusable', 'not-email', 'notifier-missing'] as const)(
    '%s: states the identity rule, still offers select-another/clear, and issues no row instruction',
    (status) => {
      // Every non-ok render keeps BOTH of the card's own actions reachable: another eligible
      // sender (nf_2) and the "none" option.
      renderCard({ notifiers: [emailRow('nf_1', 'other@ex.com'), emailRow('nf_2')], saved: saved(status) });

      expect(screen.getByText(/Kindle delivery resumes only when a sender is selected here and saved/i)).toBeInTheDocument();
      expect(optionLabels()).toContain('No Kindle sender');
      expect(optionLabels()).toContain('Mail nf_2 — bot@ex.com');

      const text = screen.getByRole('alert').textContent ?? '';
      for (const instruction of ROW_INSTRUCTIONS) expect(text).not.toMatch(instruction);
    },
  );
});

describe('KindleSenderCard — zero eligible senders', () => {
  it('explains that no email notifier is available to send from', () => {
    // Degraded + non-email rows exist, so the emptiness is about ELIGIBILITY, not an empty list.
    renderCard({ notifiers: [degradedEmailRow('nf_bad'), ntfyRow('nf_n')], saved: null });

    expect(optionLabels()).toEqual(['No Kindle sender']);
    expect(screen.getByText(/No email notifier is available to send from/i)).toBeInTheDocument();
  });

  it('drops that guidance as soon as one eligible sender exists', () => {
    renderCard({ notifiers: [emailRow('nf_1'), degradedEmailRow('nf_bad')], saved: null });

    expect(screen.queryByText(/No email notifier is available to send from/i)).not.toBeInTheDocument();
  });
});

describe('KindleSenderCard — draft rebasing when the connectors query refetches (AC20)', () => {
  // The Notifications section is NOT keyed/remounted while notifier CRUD invalidates
  // qk.connectors, so the card outlives changes to its own option set. These drive the
  // component's real wiring — an unwired reconciler passes its unit tests but fails here.
  it('drops a draft whose notifier was removed, and offers no same-id Save for it', async () => {
    const user = userEvent.setup();
    const { rerenderCard } = renderCard({
      notifiers: [emailRow('nf_1'), emailRow('nf_2'), emailRow('nf_3')],
      saved: null,
    });
    await user.selectOptions(picker(), 'nf_2');
    expect(picker().value).toBe('nf_2');

    // nf_2 deleted elsewhere in the section → the refetched list no longer carries it.
    rerenderCard({ notifiers: [emailRow('nf_1'), emailRow('nf_3')], saved: null });

    expect(picker().value).toBe(''); // two eligible remain ⇒ the seeding rule yields null
    expect(optionLabels()).not.toContain('Mail nf_2 — bot@ex.com');
    expect(saveButton()).not.toBeInTheDocument();
  });

  it('keeps a still-eligible manual draft across a rerender', async () => {
    const user = userEvent.setup();
    const { rerenderCard } = renderCard({ notifiers: [emailRow('nf_1'), emailRow('nf_2')], saved: null });
    await user.selectOptions(picker(), 'nf_2');

    // An unrelated notifier appears (someone added an ntfy row) — nf_2 is still eligible.
    rerenderCard({ notifiers: [emailRow('nf_1'), emailRow('nf_2'), ntfyRow('nf_n')], saved: null });

    expect(picker().value).toBe('nf_2');
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('re-applies the sole-option preselect when the option set collapses to one', async () => {
    const user = userEvent.setup();
    const { rerenderCard } = renderCard({ notifiers: [emailRow('nf_1'), emailRow('nf_2')], saved: null });
    await user.selectOptions(picker(), 'nf_2');

    rerenderCard({ notifiers: [emailRow('nf_1')], saved: null });

    expect(picker().value).toBe('nf_1');
  });
});
