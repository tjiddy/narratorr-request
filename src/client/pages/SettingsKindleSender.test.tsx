import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { NotifierDto, ResolvedKindleSender, KindleSenderStatus } from '@shared/schemas/connectors';

// The card's only side effect is its save mutation — stub the hook so a click is observable
// without a QueryClient. Every DECISION it makes is unit-tested in settings-kindle-sender.test.ts;
// this file covers the status-dependent rendering and the query-refetch wiring, which can't be.
const hoisted = vi.hoisted(() => ({ mutate: vi.fn() }));
vi.mock('../hooks', () => ({
  useUpdateKindleSender: () => ({ mutate: hoisted.mutate, isPending: false }),
}));

import { KindleSenderCard } from './SettingsKindleSender';

const emailRow = (id: string, from = 'bot@ex.com', name = `Mail ${id}`): NotifierDto => ({
  id,
  name,
  type: 'email',
  events: ['request.created'],
  config: { host: 'smtp.example.com', port: 587, secure: false, user: null, from, to: 'a@ex.com', hasPassword: true },
});
const degradedEmailRow = (id: string): NotifierDto => ({
  id,
  name: `Broken ${id}`,
  type: 'email',
  events: ['request.created'],
  unknown: true,
});
const ntfyRow = (id: string): NotifierDto => ({
  id,
  name: `Phone ${id}`,
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

const picker = () => screen.getByLabelText('Kindle sender') as HTMLSelectElement;
const optionLabels = () => Array.from(picker().options).map((o) => o.textContent);
const saveButton = () => screen.queryByRole('button', { name: /save|reconfirm/i });

// The imperative row instructions AC22 forbids. The identity rule legitimately MENTIONS
// recreating a notifier when explaining that a replacement needs a save here — what must never
// appear is a directive to go act on a row, so match the instruction, not the words.
const ROW_INSTRUCTIONS = [/edit (this|that) notifier/i, /delete and recreate/i, /recreate it below/i];

beforeEach(() => hoisted.mutate.mockClear());

describe('KindleSenderCard — options + Save affordance', () => {
  it('renders only ELIGIBLE email notifiers plus a "none" option', () => {
    render(<KindleSenderCard notifiers={[emailRow('nf_1'), degradedEmailRow('nf_bad'), ntfyRow('nf_n')]} saved={null} />);

    expect(optionLabels()).toEqual(['No Kindle sender', 'Mail nf_1 — bot@ex.com']);
  });

  it('hides Save in both noop states (nothing saved + nothing picked, and an ok same-id draft)', () => {
    const { unmount } = render(<KindleSenderCard notifiers={[emailRow('nf_1'), emailRow('nf_2')]} saved={null} />);
    expect(picker().value).toBe(''); // two eligible ⇒ no preselect
    expect(saveButton()).not.toBeInTheDocument();
    unmount();

    render(<KindleSenderCard notifiers={[emailRow('nf_1')]} saved={saved('ok')} />);
    expect(picker().value).toBe('nf_1');
    expect(saveButton()).not.toBeInTheDocument();
  });

  it('preselects a SOLE eligible option and offers an enabled Save that persists it (never auto-saves)', async () => {
    const user = userEvent.setup();
    render(<KindleSenderCard notifiers={[emailRow('nf_1')]} saved={null} />);

    expect(picker().value).toBe('nf_1');
    expect(hoisted.mutate).not.toHaveBeenCalled(); // seeding persists nothing

    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(hoisted.mutate).toHaveBeenCalledTimes(1);
    expect(hoisted.mutate).toHaveBeenCalledWith({ kindleSender: { notifierId: 'nf_1' } });
  });

  it('selecting a different eligible option yields a Save that persists that id', async () => {
    const user = userEvent.setup();
    render(<KindleSenderCard notifiers={[emailRow('nf_1'), emailRow('nf_2')]} saved={saved('ok')} />);

    await user.selectOptions(picker(), 'nf_2');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(hoisted.mutate).toHaveBeenCalledWith({ kindleSender: { notifierId: 'nf_2' } });
  });

  it('selecting "none" clears when something is saved, and is inert when nothing is', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<KindleSenderCard notifiers={[emailRow('nf_1')]} saved={saved('ok')} />);
    await user.selectOptions(picker(), '');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(hoisted.mutate).toHaveBeenCalledWith({ kindleSender: null });
    unmount();
    hoisted.mutate.mockClear();

    render(<KindleSenderCard notifiers={[emailRow('nf_1')]} saved={null} />);
    await user.selectOptions(picker(), ''); // deselect the preselected sole option
    expect(saveButton()).not.toBeInTheDocument();
    expect(hoisted.mutate).not.toHaveBeenCalled();
  });
});

describe('KindleSenderCard — the status matrix', () => {
  it('ok: shows the exact address to allowlist at Amazon, and no Save', () => {
    render(<KindleSenderCard notifiers={[emailRow('nf_1')]} saved={saved('ok')} />);

    expect(screen.getByText(/Approved Personal Document E-mail List/i)).toBeInTheDocument();
    expect(screen.getByText('bot@ex.com')).toBeInTheDocument();
    expect(saveButton()).not.toBeInTheDocument();
  });

  it('sender-changed: shows currentFrom + the confirmed address, and a SAME-ID reconfirm Save', async () => {
    const user = userEvent.setup();
    render(<KindleSenderCard notifiers={[emailRow('nf_1', 'new@ex.com')]} saved={saved('sender-changed')} />);

    expect(screen.getByText(/now sends as new@ex.com \(confirmed: bot@ex.com\)/i)).toBeInTheDocument();
    expect(picker().value).toBe('nf_1'); // the saved id is still eligible, so it seeds the draft

    const reconfirm = screen.getByRole('button', { name: 'Reconfirm sender' });
    await user.click(reconfirm);
    expect(hoisted.mutate).toHaveBeenCalledWith({ kindleSender: { notifierId: 'nf_1' } });
  });

  it('from-unparseable: diagnoses the From and offers NO same-id Save (it would be a guaranteed 400)', () => {
    // The row is still eligible (a string `from`), so the draft seeds to it — but the intent is
    // noop, because AC8 rejects a same-id write outside sender-changed.
    render(<KindleSenderCard notifiers={[emailRow('nf_1', 'ops team')]} saved={saved('from-unparseable')} />);

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
    render(<KindleSenderCard notifiers={notifiers} saved={saved(status)} />);

    expect(screen.getByText(copy)).toBeInTheDocument();
    expect(picker().value).toBe(''); // an ineligible saved id never enters the picker…

    // …so the Save that renders is the CLEAR intent, never a same-id write (which AC8 would 400).
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(hoisted.mutate).toHaveBeenCalledWith({ kindleSender: null });
  });

  it.each(['sender-changed', 'from-unparseable', 'config-unusable', 'not-email', 'notifier-missing'] as const)(
    '%s: states the identity rule, still offers select-another/clear, and issues no row instruction',
    (status) => {
      // Every non-ok render keeps BOTH of the card's own actions reachable: another eligible
      // sender (nf_2) and the "none" option.
      render(<KindleSenderCard notifiers={[emailRow('nf_1', 'other@ex.com'), emailRow('nf_2')]} saved={saved(status)} />);

      expect(screen.getByText(/Kindle delivery resumes only when a sender is selected here and saved/i)).toBeInTheDocument();
      expect(optionLabels()).toContain('No Kindle sender');
      expect(optionLabels()).toContain('Mail nf_2 — bot@ex.com');

      const text = screen.getByRole('alert').textContent ?? '';
      for (const instruction of ROW_INSTRUCTIONS) expect(text).not.toMatch(instruction);
    },
  );
});

describe('KindleSenderCard — draft rebasing when the connectors query refetches (AC20)', () => {
  // The Notifications section is NOT keyed/remounted while notifier CRUD invalidates
  // qk.connectors, so the card outlives changes to its own option set. These drive the
  // component's real wiring — an unwired reconciler passes its unit tests but fails here.
  it('drops a draft whose notifier was removed, and offers no same-id Save for it', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <KindleSenderCard notifiers={[emailRow('nf_1'), emailRow('nf_2'), emailRow('nf_3')]} saved={null} />,
    );
    await user.selectOptions(picker(), 'nf_2');
    expect(picker().value).toBe('nf_2');

    // nf_2 deleted elsewhere in the section → the refetched list no longer carries it.
    rerender(<KindleSenderCard notifiers={[emailRow('nf_1'), emailRow('nf_3')]} saved={null} />);

    expect(picker().value).toBe(''); // two eligible remain ⇒ the seeding rule yields null
    expect(optionLabels()).not.toContain('Mail nf_2 — bot@ex.com');
    expect(saveButton()).not.toBeInTheDocument();
  });

  it('keeps a still-eligible manual draft across a rerender', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<KindleSenderCard notifiers={[emailRow('nf_1'), emailRow('nf_2')]} saved={null} />);
    await user.selectOptions(picker(), 'nf_2');

    // An unrelated notifier appears (someone added an ntfy row) — nf_2 is still eligible.
    rerender(<KindleSenderCard notifiers={[emailRow('nf_1'), emailRow('nf_2'), ntfyRow('nf_n')]} saved={null} />);

    expect(picker().value).toBe('nf_2');
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('re-applies the sole-option preselect when the option set collapses to one', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<KindleSenderCard notifiers={[emailRow('nf_1'), emailRow('nf_2')]} saved={null} />);
    await user.selectOptions(picker(), 'nf_2');

    rerender(<KindleSenderCard notifiers={[emailRow('nf_1')]} saved={null} />);

    expect(picker().value).toBe('nf_1');
  });
});
