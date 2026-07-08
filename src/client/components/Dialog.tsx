import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { XIcon } from './icons';

/**
 * The app's REUSABLE, accessible dialog primitive (issue #131). Both the account modal
 * (`AccountModal.tsx`) and the notifier modal (`SettingsNotifiers.tsx`) render through it.
 *
 * Accessibility: `role="dialog" aria-modal`, focus moves into the card on open and RETURNS to the
 * trigger on close (the piece the bespoke notifier modal lacked), and Esc + overlay-click + the X
 * button all close. Portaled to `<body>` so `position: fixed` is viewport-relative and escapes any
 * `backdrop-blur` ancestor that would otherwise trap the overlay.
 *
 * Two consumer-driven affordances (kept minimal on purpose — no general theming API): `size` widens
 * the card for the two-column notifier form (`lg`) vs. the narrow account modal (`sm`, the default),
 * and `scrollBody` caps the card height and scrolls the body so a tall form doesn't overflow the
 * viewport. The X button sits outside the scroll region, so it stays pinned while the body scrolls.
 *
 * Focus/keyboard handling is genuine DOM-only orchestration (no pure seam), so it lives here and is
 * not node-testable — consistent with the repo's extract-pure-logic-only testing stance
 * (frontend-logic-extract-not-jsdom). The decision logic the consumers need (dirty-state, provider
 * label, notifier payload/validation) is extracted into pure helpers with unit coverage instead.
 */
export function Dialog({
  open,
  onClose,
  children,
  labelledBy,
  size = 'sm',
  scrollBody = false,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** id of the element that names the dialog (the identity block heading), for `aria-labelledby`. */
  labelledBy?: string;
  /** `sm` (default) = narrow account modal; `lg` = the wider two-column notifier form. */
  size?: 'sm' | 'lg';
  /** Cap the card at 85vh and scroll the body internally for tall content (the notifier form). */
  scrollBody?: boolean;
}) {
  const cardRef = useRef<HTMLDivElement>(null);

  // Capture the trigger and move focus in on open; restore focus to the trigger on close/unmount.
  // Keyed on `open` only, so a changing `onClose` identity can't re-run the focus dance mid-open.
  useEffect(() => {
    if (!open) return;
    const trigger = document.activeElement as HTMLElement | null;
    cardRef.current?.focus();
    return () => trigger?.focus();
  }, [open]);

  // Esc closes. Separate effect so it can depend on the latest `onClose` without touching focus.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-center px-4 pt-[12vh]">
      <div className="absolute inset-0 bg-black/55 backdrop-blur" onClick={onClose} />
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        {...(labelledBy !== undefined && { 'aria-labelledby': labelledBy })}
        className={`relative h-fit w-full ${size === 'lg' ? 'max-w-3xl' : 'max-w-[27rem]'} rounded-[1.25rem] border border-border/60 bg-card/92 shadow-2xl outline-none backdrop-blur-xl${scrollBody ? ' flex max-h-[85vh] flex-col overflow-hidden' : ''}`}
      >
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="absolute right-3 top-3 z-10 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-ring"
        >
          <XIcon className="h-5 w-5" />
        </button>
        {scrollBody ? <div className="overflow-y-auto">{children}</div> : children}
      </div>
    </div>,
    document.body,
  );
}
