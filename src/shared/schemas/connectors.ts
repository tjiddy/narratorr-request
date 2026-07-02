import { z } from 'zod';
import { httpUrl } from './field-helpers.js';
import { notificationEventSchema, type NotificationEvent } from '../notification-events.js';
import { NOTIFIER_DEFS, NOTIFIER_TYPES, type NotifierType } from '../notifier-registry.js';

// =============================================================================
// Connector settings — the narratorr connection + a list of N notifiers, edited on
// the admin Settings page. Layers:
//   • StoredConnectors  — shape persisted in app_settings.connectors (secrets ENCRYPTED).
//   • ConnectorSettingsDto — masked GET payload (secrets become has* / host-hints).
//   • UpdateConnectorSettingsBody — PUT body (publicUrl + narratorr only).
//   • Create/Update/Test notifier bodies — per-notifier CRUD.
//
// Notifiers are a generalized list (Sonarr/Radarr-style Connections): each has a name,
// a type (from the shared registry), the events it fires on, and type-specific config. The registry (src/shared/notifier-registry.ts) is the single
// source of truth for field metadata + config/masked schemas + secret metadata.
// =============================================================================

// narratorr Server URL: the full base URL of the narratorr instance (`http://narratorr:3000`,
// `http://[::1]:3000`, `http://host:3000/lib`). Reuses the shared `httpUrl` helper (scheme
// required, trailing slashes stripped) plus a host-exists refinement so a bare `http://` with
// no host is rejected. Internal/private hosts and IPv6 literals are intentionally allowed —
// this is trusted server-to-server admin config, NOT the public-only coverUrl SSRF guard
// (`isInternalHost` in request.ts). The refinement is narratorr-specific (not folded into the
// shared `httpUrl`) so publicUrl/notifier fields keep their existing, looser behavior.
const narratorrUrl = httpUrl.refine((v) => {
  try {
    return new URL(v).hostname !== '';
  } catch {
    return false;
  }
}, 'enter a valid http(s) URL including a host');

// ---- Default request quota --------------------------------------------------
// The app-wide default request quota, editable on the admin Settings page. It applies to
// users without a per-user override (admins stay unlimited; per-user auto-approve users are
// still capped). The window is exposed as friendly day/week/month units that map to a FIXED
// rolling-window day count — no calendar period, no reset date. Quotas are explicit POLICY MODES
// (discriminated unions), never an overloaded `number | null`: a number only ever means a positive
// cap, and `0` is rejected everywhere on the write side.

/** Allowed rolling-window sizes in days — the friendly day / week / month units. The single
 *  source of truth for the window: `quotaWindowDaysSchema` derives its literal union from this
 *  tuple (#78), so the client window map and the schema can never hand-drift apart. */
export const QUOTA_WINDOW_DAYS = [1, 7, 30] as const;
export type QuotaWindowDays = (typeof QUOTA_WINDOW_DAYS)[number];

/**
 * Upper bound on a request quota limit. Mirrors the notifier-field cap precedent
 * (`NOTIFIER_NAME_MAX` / `NOTIFIER_EVENTS_MAX` below) on the same "admin-only row, keep a
 * fat-fingered/abusive value from doing something silly" reasoning: a quota is requests-per-window,
 * so a six-figure cap is already far past any real ceiling. Shared by the server `quotaLimitSchema`
 * and the client positive-int limit guard so the two can never drift. Without it, an absurdly long
 * pasted digit string parses past `Number.MAX_SAFE_INTEGER` (or `Infinity`). Retained under the
 * mode redesign — it's an existing unsafe-number guard, orthogonal to killing the overloaded `0`. */
export const DEFAULT_QUOTA_LIMIT_MAX = 100_000;

/** `windowDays` is constrained to the allowed set so the unit dropdown is the single source of
 *  truth. Derived from `QUOTA_WINDOW_DAYS` (Zod v4 literal-union) so there's no duplicated `{1,7,30}`.
 *  Exported so the server can narrow the stored column value to the literal union. */
export const quotaWindowDaysSchema = z.literal(QUOTA_WINDOW_DAYS);

/** A quota limit is ONLY ever a positive integer (no `0`, no `null`) capped at the shared ceiling.
 *  The discriminated unions below put this on the `limited` arm exclusively, so a limit can never
 *  ride a non-`limited` mode. */
export const quotaLimitSchema = z.number().int().positive().max(DEFAULT_QUOTA_LIMIT_MAX);

/**
 * The app-wide default request quota as an explicit policy mode. Used for BOTH the update body
 * (PUT /connectors) AND the masked GET DTO — one schema, both sides of the wire — so the mode-first
 * editor can load existing state, not just save it. `windowDays` rides BOTH modes (it's the global
 * rolling-window measurement, preserved when toggling unlimited). The discriminated union makes
 * illegal states unrepresentable: no `limit` on `unlimited`, a required positive `limit` on `limited`.
 */
export const defaultQuotaSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('unlimited'), windowDays: quotaWindowDaysSchema }),
  z.strictObject({ mode: z.literal('limited'), limit: quotaLimitSchema, windowDays: quotaWindowDaysSchema }),
]);
export type DefaultQuota = z.infer<typeof defaultQuotaSchema>;

// ---- Stored shape -----------------------------------------------------------
/**
 * A notifier as persisted. `type` is a BARE STRING (not the registry-derived
 * `NotifierType`) and `config` is OPAQUE on purpose: a stored row whose type is no
 * longer in the registry must still parse and round-trip — never be rejected or
 * dropped by the storage boundary. Secret fields inside `config` hold `enc:v1:…`
 * strings at rest. `NotifierType` is applied only when narrowing a known row into its
 * typed config + adapter.
 */
export interface StoredNotifier {
  id: string;
  name: string;
  type: string;
  events: NotificationEvent[];
  config: Record<string, unknown>;
}

/**
 * Type-lenient storage schema for a stored notifier — `type: string`, opaque config.
 * Used to validate/round-trip stored rows; an out-of-registry `type` must still parse.
 */
export const storedNotifierSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  events: z.array(notificationEventSchema),
  config: z.record(z.string(), z.unknown()),
});

/**
 * As persisted. The narratorr secret (apiKey) holds an `enc:v1:…` string at rest;
 * `notifiers` is the generalized notifier list (secrets encrypted inside each config).
 */
export interface StoredConnectors {
  publicUrl: string | null;
  narratorr: { url: string; apiKey: string } | null;
  notifiers: StoredNotifier[];
}

/**
 * Container/ENVELOPE guard for the whole stored `connectors` blob — NOT a strict content validator.
 * It asserts only the structural shape the readers need to stay crash-safe (object/array/string at
 * the envelope level), so a corrupt/hand-edited/legacy blob degrades to a clean reset instead of
 * throwing `value.startsWith is not a function` out of a boot/settings read. It deliberately keeps
 * the layers that already have their own never-brick degrade paths as `unknown`:
 *   • Secret VALUES (`narratorr.apiKey`, notifier `config` secret fields) stay `unknown` — a
 *     non-string secret passes the envelope and is treated as "unconfigured" at runtime by
 *     `reveal()` + the shared usable-secret mask predicate, NOT a whole-blob reset.
 *   • Notifier `events` is loosened to `unknown` — malformed events keep degrading ROW-LOCALLY via
 *     `safeEvents()` on BOTH read surfaces (the DTO path in `toNotifierDto` AND the runtime path in
 *     `toRuntimeNotifier`, so a non-iterable value like `events: 42` can never reach `new Set()` at
 *     boot), NOT a whole-blob reset (composing `storedNotifierSchema` verbatim would turn a
 *     bad-events row into a tier-2 wipe).
 * A blob that fails THIS schema (bad envelope: not an object; `notifiers` not an array; `narratorr`
 * neither null nor `{ url: string, … }`; `publicUrl` neither null nor a string; a notifier row that
 * is not an object / lacks a string `id`/`name`/`type` / has a non-object `config`) is what the read
 * path degrades wholesale to EMPTY + one warn. Non-`.strict()` per CLAUDE.md — the stored boundary
 * tolerates extra keys, and an out-of-registry notifier `type` must still round-trip.
 */
export const storedConnectorsSchema = z.object({
  publicUrl: z.string().nullable(),
  narratorr: z.object({ url: z.string(), apiKey: z.unknown() }).nullable(),
  notifiers: z.array(storedNotifierSchema.omit({ events: true }).extend({ events: z.unknown() })),
});

// ---- Masked notifier DTO (GET) ----------------------------------------------
// Discriminated so an unknown stored type is PRESERVED end-to-end, not 500'd:
//   • Known: { id, name, type: <registry key>, events, config: <masked> }
//   • Unknown: { id, name, type: <raw string>, events, unknown: true }
//     — no config, rendered deletable.
const knownNotifierDtoSchemas = NOTIFIER_DEFS.map((def) =>
  z.object({
    id: z.string(),
    name: z.string(),
    type: z.literal(def.type),
    events: z.array(notificationEventSchema),
    config: def.maskedConfigSchema,
  }),
);

export const unknownNotifierDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  events: z.array(notificationEventSchema),
  unknown: z.literal(true),
});

// z.union wants a >=2 tuple; the spread yields an array, so cast to satisfy the type. The
// inferred type of a ZodTypeAny union collapses to `unknown`, so the DTO TS types below are
// hand-written (discriminated, accurate) — this schema is the runtime/response validator only.
export const notifierDtoSchema = z.union([
  ...knownNotifierDtoSchemas,
  unknownNotifierDtoSchema,
] as unknown as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);

/** A known notifier in the masked GET DTO — `config` carries masked secrets (has* / host-hints). */
export interface KnownNotifierDto {
  id: string;
  name: string;
  type: NotifierType;
  events: NotificationEvent[];
  config: Record<string, unknown>;
}
/** A stored notifier whose type is no longer in the registry — deletable, no config. */
export interface UnknownNotifierDto {
  id: string;
  name: string;
  type: string;
  events: NotificationEvent[];
  unknown: true;
}
export type NotifierDto = KnownNotifierDto | UnknownNotifierDto;

// ---- Masked connector-settings DTO (GET) ------------------------------------
export const connectorSettingsDtoSchema = z.object({
  publicUrl: z.string().nullable(),
  narratorr: z
    .object({
      url: z.string(),
      hasApiKey: z.boolean(),
    })
    .nullable(),
  notifiers: z.array(notifierDtoSchema),
  defaultQuota: defaultQuotaSchema,
});
/** Hand-written (the runtime schema's `notifiers` infers `unknown[]`; this keeps it typed). */
export interface ConnectorSettingsDto {
  publicUrl: string | null;
  narratorr: { url: string; hasApiKey: boolean } | null;
  notifiers: NotifierDto[];
  defaultQuota: DefaultQuota;
}

// ---- narratorr connector (shared by PUT + Test) -----------------------------
// Non-`.strict()` per CLAUDE.md (tolerate provider/UI drift on unused nested keys) —
// the .strict() guard lives on the top-level bodies only. Secrets optional (omit-to-keep).
const narratorrConnectorSchema = z.object({
  url: narratorrUrl,
  apiKey: z.string().trim().optional(),
});

// ---- Update body (PUT /connectors) ------------------------------------------
// Now carries ONLY publicUrl + narratorr — the notification channels moved to the
// per-notifier CRUD routes. publicUrl: omitted → keep, null → clear, value → set.
export const updateConnectorSettingsBodySchema = z
  .object({
    publicUrl: httpUrl.nullable().optional(),
    narratorr: narratorrConnectorSchema.nullable().optional(),
    // Default request quota as an explicit mode (`unlimited` | `limited`). The mode-first editor
    // always sends `windowDays` (the unit dropdown is the source of truth), so it rides both modes;
    // a `limited` mode carries a required positive `limit`. The whole object omitted → keep the
    // stored quota columns untouched.
    defaultQuota: defaultQuotaSchema.optional(),
  })
  .strict();
export type UpdateConnectorSettingsBody = z.infer<typeof updateConnectorSettingsBodySchema>;

// ---- Test the narratorr connection (POST /connectors/test) -------------------
// Probes the CURRENT (unsaved) narratorr form values without persisting. Secrets stay
// optional (omit-to-keep → falls back to the stored secret server-side). Notifier tests
// have their own route + body (notifierTestBodySchema) below.
export const testConnectorBodySchema = z
  .object({
    channel: z.literal('narratorr'),
    narratorr: narratorrConnectorSchema.nullable().optional(),
  })
  .strict();
export type TestConnectorBody = z.infer<typeof testConnectorBodySchema>;

export const testConnectorResultSchema = z.object({
  success: z.boolean(),
  message: z.string(),
});
export type TestConnectorResult = z.infer<typeof testConnectorResultSchema>;

// ---- Notifier CRUD bodies ----------------------------------------------------
// The envelope is validated here (name/type/events); the type-specific `config`
// is validated server-side against the registry's per-type `configSchema` (the type is
// only known at runtime). `config` stays opaque at this layer.
// Bounds are proportionate (admin-only, single JSON row): a sane `name` ceiling and a
// soft cap on the event list keep a fat-fingered/abusive body from bloating the blob. The
// open `config` record stays unbounded here — each type's `configSchema` constrains it
// downstream (see CLAUDE.md: don't over-engineer the opaque config layer).
const NOTIFIER_NAME_MAX = 100;
const NOTIFIER_EVENTS_MAX = 20;
const notifierWriteBodySchema = z
  .object({
    name: z.string().trim().min(1).max(NOTIFIER_NAME_MAX),
    type: z.enum(NOTIFIER_TYPES),
    events: z.array(notificationEventSchema).min(1).max(NOTIFIER_EVENTS_MAX),
    config: z.record(z.string(), z.unknown()),
  })
  .strict();
export const createNotifierBodySchema = notifierWriteBodySchema;
export const updateNotifierBodySchema = notifierWriteBodySchema;
export type CreateNotifierBody = z.infer<typeof createNotifierBodySchema>;
export type UpdateNotifierBody = z.infer<typeof updateNotifierBodySchema>;

// ---- Test a notifier candidate (POST /notifiers/test) -----------------------
// Fires a sample event through the built channel from the CURRENT (unsaved) form values —
// no save required. `event` selects WHICH sample is sent (the client picks from the
// notifier's selected events) so Test exercises the event the notifier is actually
// configured for; it defaults to `request.created` to preserve the legacy probe when
// omitted. `id` (edit) → omit-to-keep secrets against the stored notifier; absent
// (create) → required secrets must be present. Always returns 200.
export const notifierTestBodySchema = z
  .object({
    type: z.enum(NOTIFIER_TYPES),
    config: z.record(z.string(), z.unknown()),
    event: notificationEventSchema.default('request.created'),
    id: z.string().optional(),
    publicUrl: httpUrl.nullable().optional(),
  })
  .strict();
export type NotifierTestBody = z.infer<typeof notifierTestBodySchema>;
