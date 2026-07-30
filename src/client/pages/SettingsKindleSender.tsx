import { useState } from 'react';
import type { NotifierDto, ResolvedKindleSender } from '@shared/schemas/connectors';
import { useUpdateKindleSender } from '../hooks';
import { Button } from '../components/Button';
import { CheckIcon } from '../components/icons';
import { Field, SettingsCard } from './settings-ui';
import { inputCls } from './settings-fields';
import {
  eligibleKindleSenders,
  seedKindleDraft,
  rebaseKindleDraft,
  kindleSenderIntent,
  buildKindleSenderBody,
  kindleSenderDiagnosis,
  KINDLE_IDENTITY_RULE,
} from './settings-kindle-sender';

// The stable Kindle sender (issue #143). Amazon's Approved Personal Document E-mail List is
// PER-SENDER, so Kindle delivery must come from one admin-confirmed mailbox — never the "first
// usable email notifier" the requester-email path picks. This card owns choosing it; the parsed
// mailbox is always server-derived (nodemailer is Node-only, so the browser never parses one).
//
// All decision logic lives in settings-kindle-sender.ts; this file is rendering + wiring.

const NONE = '';

export function KindleSenderCard({
  notifiers,
  saved,
}: {
  notifiers: NotifierDto[];
  saved: ResolvedKindleSender | null;
}) {
  const update = useUpdateKindleSender();
  const options = eligibleKindleSenders(notifiers);

  // The draft is reconciled when the SAVED selection or the eligible option set changes — not on
  // every render (that would stomp a manual pick) and not once at mount (the Notifications
  // section stays mounted while notifier CRUD invalidates the connectors query, so the option set
  // can change underneath it). `selectedId` is computed rather than read straight off state so
  // the AC20 invariant — always an eligible id or null — holds even in the render that detects
  // the change, before React restarts it with the stored value.
  const signature = `${saved?.notifierId ?? ''}|${saved?.status ?? ''}|${options.map((o) => o.id).join(',')}`;
  const [prev, setPrev] = useState(() => ({ signature, selectedId: seedKindleDraft(saved, options) }));
  const selectedId =
    prev.signature === signature ? prev.selectedId : rebaseKindleDraft(prev.selectedId, saved, options);
  if (prev.signature !== signature) setPrev({ signature, selectedId });

  const setSelectedId = (next: string | null) => setPrev({ signature, selectedId: next });

  const intent = kindleSenderIntent(saved, selectedId);
  const isReconfirm = intent === 'set' && selectedId !== null && selectedId === saved?.notifierId;

  function save() {
    const body = buildKindleSenderBody(saved, selectedId);
    if (body) update.mutate(body);
  }

  return (
    <SettingsCard delay="30ms">
      <form
        className="flex flex-col gap-4 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <Field
          label="Kindle sender"
          hint="Kindle delivery always sends from this one mailbox, so the address your users allowlist at Amazon never changes."
        >
          <select
            className={inputCls}
            // Explicit accessible name: `Field`'s <label> also wraps the hint text, so the
            // computed name would otherwise swallow the whole paragraph (same reason the quota
            // selects carry one).
            aria-label="Kindle sender"
            value={selectedId ?? NONE}
            onChange={(e) => setSelectedId(e.target.value === NONE ? null : e.target.value)}
          >
            <option value={NONE}>No Kindle sender</option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name} — {o.from}
              </option>
            ))}
          </select>
        </Field>

        {options.length === 0 && (
          <p className="text-xs text-muted-foreground/70">
            No email notifier is available to send from. Add one below to enable Kindle delivery.
          </p>
        )}

        <KindleSenderStatusBlock saved={saved} notifiers={notifiers} />

        {intent !== 'noop' && (
          <div className="flex justify-end">
            <Button variant="primary" size="sm" icon={CheckIcon} loading={update.isPending} type="submit">
              {isReconfirm ? 'Reconfirm sender' : 'Save'}
            </Button>
          </div>
        )}
      </form>
    </SettingsCard>
  );
}

/**
 * The saved sender's state. `ok` shows the exact string to add to Amazon's list; every other
 * status pairs its DIAGNOSIS with the identity rule. Copy deliberately never instructs a row
 * action in the notifier list ("edit this notifier", "delete and recreate it") — those
 * affordances live in another component and differ per row kind, so a procedure stated here
 * could not be kept true. The identity rule covers every repair shape instead.
 */
function KindleSenderStatusBlock({ saved, notifiers }: { saved: ResolvedKindleSender | null; notifiers: NotifierDto[] }) {
  if (!saved) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        No Kindle sender is confirmed yet, so Kindle delivery is unavailable.
      </p>
    );
  }

  if (saved.status === 'ok') {
    // No green callout (UAT 2026-07-29): allowlisting is a USER-side action — each user adds the
    // sender to their own Amazon approved list, and the app shows them the address during Kindle
    // setup (account modal + ebook sheet). The admin just needs to know that's handled.
    return (
      <p role="status" className="text-xs text-muted-foreground/70">
        Your users add this address to their own Amazon approved list — the app shows it to them
        during Kindle setup.
      </p>
    );
  }

  const name = notifiers.find((n) => n.id === saved.notifierId)?.name ?? null;
  return (
    <div
      role="alert"
      className="flex flex-col gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-700 dark:text-amber-300"
    >
      {name && <p>Saved sender: “{name}”.</p>}
      <p>{kindleSenderDiagnosis(saved)}</p>
      <p className="text-xs opacity-90">{KINDLE_IDENTITY_RULE}</p>
    </div>
  );
}
