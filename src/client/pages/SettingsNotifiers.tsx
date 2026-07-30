import { useState, useId } from 'react';
import { isKnownNotifierDto } from '@shared/schemas/connectors';
import type { NotifierDto, KnownNotifierDto } from '@shared/schemas/connectors';
import { NOTIFIER_REGISTRY, NOTIFIER_TYPES, type NotifierType, type NotifierField } from '@shared/notifier-registry';
import { NOTIFICATION_EVENTS } from '@shared/notification-events';
import { useCreateNotifier, useUpdateNotifier, useDeleteNotifier, useTestNotifier } from '../hooks';
import { Button } from '../components/Button';
import { BellIcon, PlusIcon, PencilIcon, SendIcon, TrashIcon } from '../components/icons';
import { Dialog } from '../components/Dialog';
import { Field, SectionHeader, SettingsCard } from './settings-ui';
import { inputCls, secretPlaceholder } from './settings-fields';
import {
  newNotifierForm,
  formFromDto,
  toggleEvent,
  buildNotifierBody,
  buildNotifierTestBody,
  validateNotifierForm,
  showClearAffordance,
  secretFieldHint,
  type NotifierFormState,
} from './settings-notifiers';

export function NotifiersSection({
  notifiers,
  publicUrl,
  requesterEmailWarning,
}: {
  notifiers: NotifierDto[];
  publicUrl: string | null;
  requesterEmailWarning: boolean;
}) {
  const [editing, setEditing] = useState<NotifierFormState | null>(null);
  const del = useDeleteNotifier();
  const test = useTestNotifier();

  // Test a SAVED notifier straight from its card: rebuild the candidate from the masked
  // DTO (secrets blank → omit-to-keep, resolved by id server-side), exactly as the modal
  // does. The test body samples the notifier's first selected event (null → no event, Test
  // is hidden on the card below).
  const testSaved = (n: KnownNotifierDto) => {
    const body = buildNotifierTestBody(formFromDto(n), publicUrl);
    if (body) test.mutate(body);
  };

  return (
    <div className="flex flex-col gap-5">
      <SectionHeader
        icon={BellIcon}
        title="Notifications"
        subtitle="Add destinations that fire on new requests, signups, and failures."
        action={
          <Button variant="primary" size="sm" icon={PlusIcon} onClick={() => setEditing(newNotifierForm(NOTIFIER_TYPES[0]))}>
            Add Notifier
          </Button>
        }
      />

      {requesterEmailWarning && (
        <div
          role="alert"
          className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-700 dark:text-amber-300"
        >
          Some users opted in to email notifications about their requests, but no usable email
          notifier is configured — those emails won’t be delivered. Add an <strong>email</strong>{' '}
          notifier below to enable requester notifications.
        </div>
      )}

      {notifiers.length === 0 ? (
        <SettingsCard delay="60ms">
          <p className="p-8 text-center text-sm text-muted-foreground">
            No notifiers yet — add one to get notified about new requests and signups.
          </p>
        </SettingsCard>
      ) : (
        <div className="flex flex-col gap-4">
          {notifiers.map((n, i) => (
            <NotifierCard
              key={n.id}
              notifier={n}
              delay={`${60 + i * 50}ms`}
              {...(isKnownNotifierDto(n) && {
                onEdit: () => setEditing(formFromDto(n)),
                // No event selected → nothing to sample → hide Test (the modal requires ≥1
                // event, but a leniently-stored notifier can have none).
                ...(n.events.length > 0 && { onTest: () => testSaved(n) }),
              })}
              onDelete={() => del.mutate(n.id)}
              testing={test.isPending && test.variables?.id === n.id}
              deleting={del.isPending && del.variables === n.id}
            />
          ))}
        </div>
      )}

      {editing && (
        <NotifierModal form={editing} setForm={setEditing} publicUrl={publicUrl} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}

function NotifierCard({
  notifier,
  delay,
  onEdit,
  onTest,
  onDelete,
  testing,
  deleting,
}: {
  notifier: NotifierDto;
  delay?: string | undefined;
  onEdit?: () => void;
  onTest?: () => void;
  onDelete: () => void;
  testing: boolean;
  deleting: boolean;
}) {
  const known = isKnownNotifierDto(notifier);
  const typeLabel = known ? NOTIFIER_REGISTRY[notifier.type as NotifierType].label : notifier.type;
  const eventLabels = notifier.events.map((e) => NOTIFICATION_EVENTS.find((ev) => ev.key === e)?.label ?? e).join(', ');

  return (
    <SettingsCard delay={delay}>
      <div className="flex items-center justify-between gap-4 p-5">
        <div className="flex min-w-0 items-center gap-4">
          <span className={`h-3 w-3 shrink-0 rounded-full ${known ? 'bg-success animate-pulse' : 'bg-muted-foreground/40'}`} />
          <div className="min-w-0">
            <h3 className="truncate font-display font-semibold">{notifier.name}</h3>
            <p className="truncate text-sm text-muted-foreground">{typeLabel}</p>
            <p className="mt-0.5 truncate text-xs text-muted-foreground/80">
              {known ? (eventLabels ? `Events: ${eventLabels}` : 'No events selected') : 'Unknown type — delete to remove.'}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {onEdit && (
            <Button variant="secondary" size="sm" icon={PencilIcon} onClick={onEdit} aria-label={`Edit ${notifier.name}`}>
              <span className="hidden sm:inline">Edit</span>
            </Button>
          )}
          {onTest && (
            <Button variant="secondary" size="sm" icon={SendIcon} loading={testing} onClick={onTest} aria-label={`Test ${notifier.name}`}>
              <span className="hidden sm:inline">Test</span>
            </Button>
          )}
          <Button variant="destructive" size="sm" icon={TrashIcon} loading={deleting} onClick={onDelete} aria-label={`Delete ${notifier.name}`}>
            <span className="hidden sm:inline">Delete</span>
          </Button>
        </div>
      </div>
    </SettingsCard>
  );
}

function NotifierModal({
  form,
  setForm,
  publicUrl,
  onClose,
}: {
  form: NotifierFormState;
  setForm: (f: NotifierFormState) => void;
  publicUrl: string | null;
  onClose: () => void;
}) {
  const create = useCreateNotifier();
  const edit = useUpdateNotifier();
  const test = useTestNotifier();
  const [submitted, setSubmitted] = useState(false);
  const headingId = useId();

  const def = NOTIFIER_REGISTRY[form.type];
  const errors = validateNotifierForm(form);
  const isValid = Object.keys(errors).length === 0;
  const showError = (k: string) => (submitted ? errors[k] : undefined);

  const setField = (key: string, value: string | boolean) => setForm({ ...form, fields: { ...form.fields, [key]: value } });
  const setClear = (key: string, value: boolean) => setForm({ ...form, clear: { ...form.clear, [key]: value } });

  function save() {
    setSubmitted(true);
    if (!isValid) return;
    const body = buildNotifierBody(form);
    if (form.id) {
      edit.mutate({ id: form.id, body }, { onSuccess: onClose });
    } else {
      create.mutate(body, { onSuccess: onClose });
    }
  }

  function runTest() {
    setSubmitted(true);
    if (!isValid) return;
    const body = buildNotifierTestBody(form, publicUrl);
    if (body) test.mutate(body);
  }

  // Dialog owns the portal-to-<body> (escaping the Settings page's backdrop-blur ancestor),
  // overlay, Esc/overlay-click close, and focus capture/return. The wide two-column form scrolls
  // internally via Dialog's `scrollBody` when it exceeds the viewport.
  return (
    <Dialog open onClose={onClose} size="lg" scrollBody labelledBy={headingId}>
      <div className="flex flex-col gap-5 p-6">
        <p id={headingId} className="font-display text-lg font-semibold">{form.id ? 'Edit notifier' : 'Add notifier'}</p>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Name" error={showError('name')}>
            <input className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. My phone" />
          </Field>

          <Field label="Type">
            <select className={inputCls} value={form.type} disabled={form.id !== null} onChange={(e) => setForm(newNotifierForm(e.target.value as NotifierType))}>
              {NOTIFIER_TYPES.map((t) => (
                <option key={t} value={t}>
                  {NOTIFIER_REGISTRY[t].label}
                </option>
              ))}
            </select>
          </Field>

          <div className="sm:col-span-2">
            <Field label="Events" error={showError('events')} hint="Which events this notifier fires on.">
              <div className="flex flex-wrap gap-x-5 gap-y-2">
                {NOTIFICATION_EVENTS.map((ev) => (
                  <label key={ev.key} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" className="h-4 w-4 accent-primary" checked={form.events.includes(ev.key)} onChange={() => setForm({ ...form, events: toggleEvent(form.events, ev.key) })} />
                    <span>{ev.label}</span>
                  </label>
                ))}
              </div>
            </Field>
          </div>

          {def.fields.map((f) => (
            <NotifierFieldInput key={f.key} field={f} form={form} setField={setField} setClear={setClear} error={showError(f.key)} />
          ))}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border/50 pt-4">
          <Button variant="secondary" size="sm" icon={SendIcon} loading={test.isPending} onClick={runTest}>
            Test
          </Button>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" loading={create.isPending || edit.isPending} onClick={save}>
              {form.id ? 'Save' : 'Add'}
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

function NotifierFieldInput({
  field,
  form,
  setField,
  setClear,
  error,
}: {
  field: NotifierField;
  form: NotifierFormState;
  setField: (key: string, value: string | boolean) => void;
  setClear: (key: string, value: boolean) => void;
  error?: string | undefined;
}) {
  const value = form.fields[field.key];

  if (field.kind === 'checkbox') {
    return (
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className="h-4 w-4 accent-primary" checked={Boolean(value)} onChange={(e) => setField(field.key, e.target.checked)} />
        <span>{field.label}</span>
      </label>
    );
  }

  const clearable = showClearAffordance(field, form);
  const inputEmpty = typeof value !== 'string' || value.trim() === '';
  const placeholder = field.secret ? secretPlaceholder(Boolean(form.has[field.key]), field.required) : field.placeholder;
  const inputType = field.kind === 'password' ? 'password' : field.kind === 'number' ? 'number' : 'text';

  return (
    <Field label={field.label} hint={secretFieldHint(field, form)} error={error}>
      <input className={inputCls} type={inputType} autoComplete="off" value={typeof value === 'string' ? value : ''} onChange={(e) => setField(field.key, e.target.value)} placeholder={placeholder} />
      {clearable && (
        <label className="flex items-center gap-2 text-xs text-muted-foreground/70">
          <input type="checkbox" className="h-3.5 w-3.5 accent-primary" checked={Boolean(form.clear[field.key]) && inputEmpty} disabled={!inputEmpty} onChange={(e) => setClear(field.key, e.target.checked)} />
          <span>Clear stored value</span>
        </label>
      )}
    </Field>
  );
}
