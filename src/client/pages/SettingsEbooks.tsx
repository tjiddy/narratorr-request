import { useState } from 'react';
import type { ConnectorSettingsDto } from '@shared/schemas/connectors';
import { useUpdateEbooksEnabled } from '../hooks';
import { Button } from '../components/Button';
import { ToggleSwitch } from '../components/ToggleSwitch';
import { BookIcon, CheckIcon } from '../components/icons';
import { SectionHeader, SettingsCard } from './settings-ui';
import { KindleSenderCard } from './SettingsKindleSender';
import { initEbooksEnabled, isEbooksDirty, buildEbooksEnabled } from './settings-ebooks';

// The dedicated eBooks settings section (issue #193, from UAT). Mirrors narratorr's own Ebooks
// section: a constant-label toggle row ("Enable ebook support" — the label names the SETTING;
// the switch shows the state; flip-flopping state copy like "Hidden from everyone" reads as an
// action when unchecked). Everything else in the section is progressively disclosed: until the
// SAVED value is on, the Kindle sender has nothing to deliver, so it does not render.

export function EbooksSection({
  ebooksEnabled,
  notifiers,
  kindleSender,
}: {
  ebooksEnabled: ConnectorSettingsDto['ebooksEnabled'];
  notifiers: ConnectorSettingsDto['notifiers'];
  kindleSender: ConnectorSettingsDto['kindleSender'];
}) {
  return (
    <div className="flex flex-col gap-5">
      <SectionHeader
        icon={BookIcon}
        title="eBooks"
        subtitle="Offer ebooks stored alongside your audiobooks to your approved users."
      />
      <EbooksToggleCard key={String(ebooksEnabled)} saved={ebooksEnabled} />
      {/* Disclosure keys off the SAVED state (the dto), not the draft — the sender only means
          something once ebook support is actually on, and a refetch reveals it right after the
          save lands. The card itself is the one that used to live on the Notifications page;
          it moved here unchanged (sending ebooks is not a notification). */}
      {ebooksEnabled && <KindleSenderCard notifiers={notifiers} saved={kindleSender} />}
    </div>
  );
}

// The enable toggle — narratorr's wording, adapted for the requests side of the fence. The row
// is laid out by hand rather than through <Field>: Field wraps its children in a <label>, and
// ToggleSwitch owns its OWN wrapping label (nested labels are invalid HTML). A separate text
// label targets the input via htmlFor instead, which also keeps the accessible name constant.
function EbooksToggleCard({ saved }: { saved: boolean }) {
  const update = useUpdateEbooksEnabled();
  const initial = initEbooksEnabled({ ebooksEnabled: saved });
  const [enabled, setEnabled] = useState(initial);
  const dirty = isEbooksDirty(enabled, initial);

  return (
    <SettingsCard delay="60ms">
      <form
        className="flex flex-col gap-4 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          update.mutate(buildEbooksEnabled(enabled));
        }}
      >
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <label htmlFor="ebooks-enabled" className="text-sm font-medium">
              Enable ebook support
            </label>
            <p className="mt-0.5 text-xs text-muted-foreground/70">
              Offer the eBook edition alongside the audiobook, ready to download or send to Kindle.
              Requires ebook support to be enabled in narratorr too.
            </p>
          </div>
          <ToggleSwitch
            id="ebooks-enabled"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
        </div>
        {dirty && (
          <div className="flex justify-end">
            <Button variant="primary" size="sm" icon={CheckIcon} loading={update.isPending} type="submit">
              Save
            </Button>
          </div>
        )}
      </form>
    </SettingsCard>
  );
}
