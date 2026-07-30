import type { ElementType, ReactNode } from 'react';

// Shared Settings presentational primitives — used by the connection sections, the notifier
// list/cards, and the add/edit modal. Component-only (react-refresh): pure constants/helpers
// live in settings-fields.ts; pure logic in settings-narratorr.ts / settings-notifiers.ts.

/** A labelled form field — shows an error in place of the hint when one is present.
 *  The hint/error sits OUTSIDE the `<label>` (which still wraps the control for the implicit
 *  association): label content feeds the control's accessible name, so wrapping the hint too
 *  made every screen reader announce the entire hint sentence as the field's NAME (#163).
 *  A Field with multiple controls inside still needs per-control `aria-label`s — a wrapping
 *  label can only ever name its first labelable descendant (see the quota row). */
export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">{label}</span>
        {children}
      </label>
      {error ? (
        <span className="text-xs text-destructive">{error}</span>
      ) : (
        hint && <span className="text-xs text-muted-foreground/70">{hint}</span>
      )}
    </div>
  );
}

/** The rounded, primary-tinted icon badge that fronts each section header. */
export function IconBadge({ icon: Icon }: { icon: ElementType }) {
  return (
    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
      <Icon className="h-5 w-5" />
    </div>
  );
}

/** A settings section header: icon badge + serif title + subtitle, with an optional action
 *  (e.g. an "Add Notifier" button) pinned to the right. */
export function SectionHeader({
  icon,
  title,
  subtitle,
  action,
}: {
  icon: ElementType;
  title: string;
  subtitle: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex min-w-0 items-center gap-3.5">
        <IconBadge icon={icon} />
        <div className="min-w-0">
          <h2 className="font-display text-lg font-semibold tracking-tight">{title}</h2>
          <p className="text-sm text-muted-foreground">{subtitle}</p>
        </div>
      </div>
      {action}
    </div>
  );
}

/** The spacious glass card shell (rounded-2xl, fade-in). Padding is left to the caller so a
 *  card can carry a full-bleed bordered footer (the per-card Save/Test row). */
export function SettingsCard({
  delay,
  className = '',
  children,
}: {
  delay?: string | undefined;
  className?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div
      className={`glass-card animate-fade-in-up rounded-2xl ${className}`}
      style={delay ? { animationDelay: delay } : undefined}
    >
      {children}
    </div>
  );
}
