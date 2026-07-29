import { useId, useState, type ReactNode } from 'react';
import { ChevronDownIcon } from './icons';

/**
 * A collapsed-by-default disclosure (issue #149) — the app's first, so it is shared from the start
 * rather than copied into the two sites that need it.
 *
 * Real ARIA, not a styled toggle: the trigger carries `aria-expanded` reflecting the current state
 * and `aria-controls` pointing at the panel it actually toggles. The panel id comes from `useId`
 * (the same convention `Dialog`/`EbookSheet` use for `labelledBy`), which is what lets two
 * instances be mounted at once — the account modal and the ebook sheet can both be open — without
 * their triggers pointing at each other's panel.
 *
 * The panel is UNMOUNTED while collapsed, not hidden: the click-path steps are genuinely absent
 * from the DOM, so a collapsed disclosure adds nothing for a screen reader to walk past.
 */
export function Disclosure({ label, children }: { label: string; children: ReactNode }) {
  const panelId = useId();
  const [open, setOpen] = useState(false);

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((prev) => !prev)}
        className="inline-flex items-center gap-1 rounded-lg text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-ring"
      >
        <ChevronDownIcon className={`h-3.5 w-3.5 transition-transform${open ? ' rotate-180' : ''}`} />
        {label}
      </button>
      {open && (
        <div id={panelId} className="mt-1.5">
          {children}
        </div>
      )}
    </div>
  );
}
