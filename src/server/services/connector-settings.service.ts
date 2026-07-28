import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../../db/client.js';
import { appSettings, users } from '../../db/schema.js';
import { selectEmailSource } from './notifications/requester-email.js';
import {
  confirmSenderMailbox,
  resolveKindleSender,
  KINDLE_SENDER_INVALID_MESSAGE,
} from './notifications/kindle-sender.js';
import { notificationEventSchema, type NotificationEvent } from '../../shared/notification-events.js';
import { quotaWindowDaysSchema, storedConnectorsSchema } from '../../shared/schemas/connectors.js';
import { hasNotifyOn } from '../../shared/schemas/user.js';
import type {
  StoredConnectors,
  StoredNotifier,
  ConnectorSettingsDto,
  NotifierDto,
  UpdateConnectorSettingsBody,
  TestConnectorBody,
  CreateNotifierBody,
  UpdateNotifierBody,
  NotifierTestBody,
  DefaultQuota,
} from '../../shared/schemas/connectors.js';
import {
  NOTIFIER_REGISTRY,
  isKnownNotifierType,
  type NotifierType,
  type NotifierTypeDef,
} from '../../shared/notifier-registry.js';
import type { NotificationsConfig, RuntimeNotifier } from './notifications/index.js';
import type { SecretCodec } from '../util/secret-codec.js';
import { publicId } from '../util/ids.js';
import { badRequest, notFound } from '../util/errors.js';

const SINGLETON_ID = 1;

const EMPTY: StoredConnectors = {
  publicUrl: null,
  narratorr: null,
  notifiers: [],
  kindleSender: null,
};

/** Minimal structural logger (Fastify's pino logger satisfies it). */
interface SettingsLogger {
  warn(obj: unknown, msg?: string): void;
}
const NOOP_LOGGER: SettingsLogger = { warn() {} };

/**
 * A stored secret is "usable" only when it's a non-empty string. A non-string / empty value (a
 * corrupt or hand-edited blob whose secret survives the envelope schema as `unknown`) is treated
 * as unconfigured — CONSISTENTLY by `reveal()` (runtime → null) and the masked has-secret booleans
 * (DTO → false), so the two surfaces can never disagree about whether a secret is set. A real
 * `enc:v1:…` (or legacy plaintext) string is usable; only non-strings / '' become false.
 */
function isUsableSecret(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Reads/writes the connector config (narratorr connection + the notifier list) persisted
 * in `app_settings.connectors`. Secrets are encrypted at rest; this service is the single
 * place that decrypts (for runtime use) or masks (for the API). Notifier secret handling
 * is registry-driven: the generic helpers walk each type's `secretFields` (mask / reveal /
 * resolve), so a new type needs no bespoke code here. There is NO env seeding — a fresh
 * install starts empty and is configured in the Settings UI.
 */
export class ConnectorSettingsService {
  constructor(
    private readonly db: Db,
    private readonly codec: SecretCodec,
    private readonly logger: SettingsLogger = NOOP_LOGGER,
  ) {}

  async getStored(): Promise<StoredConnectors> {
    const row = await this.db.query.appSettings.findFirst({ where: eq(appSettings.id, SINGLETON_ID) });
    return this.connectorsFrom(row);
  }

  /**
   * The connector blob off a settings row, VALIDATED at the storage boundary so a corrupt /
   * hand-edited / legacy blob can never throw out of a boot or Settings read. Three cases:
   *   • absent / null → the quiet fresh-install default `{ ...EMPTY }`, no warn (the normal state).
   *   • non-null but failing the envelope schema → `{ ...EMPTY }` + exactly one WARN, mirroring
   *     `sanitizeQuota`. A coarse whole-blob reset (per-field salvage is out of scope): the admin
   *     re-enters config rather than the app crash-looping on `value.startsWith is not a function`.
   *   • healthy → round-trips unchanged (secret VALUES / notifier `events` stay `unknown` at the
   *     schema layer, guarded downstream by `reveal()` + `safeEvents()`, so the cast back to
   *     `StoredConnectors` is the intended parse-boundary narrowing).
   */
  private connectorsFrom(row: { connectors: StoredConnectors | null } | undefined): StoredConnectors {
    const raw = row?.connectors ?? null;
    if (raw == null) return { ...EMPTY };
    const parsed = storedConnectorsSchema.safeParse(raw);
    if (!parsed.success) {
      this.logger.warn(
        { issues: parsed.error.issues },
        'stored connectors blob failed the envelope schema — treating connectors as unconfigured (re-enter them in Settings)',
      );
      return { ...EMPTY };
    }
    // `kindleSender` is `.optional()` at the schema layer so a PRE-FEATURE blob (no key at all)
    // stays a normal, warn-free read; normalize the resulting `undefined` to `null` here so every
    // reader sees exactly one shape (`exactOptionalPropertyTypes` forbids assigning `: undefined`).
    return {
      ...(parsed.data as unknown as StoredConnectors),
      kindleSender: parsed.data.kindleSender ?? null,
    };
  }

  /**
   * The app-wide default request quota, composed from the dedicated mode/limit/window columns
   * (`default_quota_mode` + `default_quota_limit` + `default_quota_window_days`) — NOT the encrypted
   * `connectors` JSON blob. Returns the explicit policy mode (`unlimited` | `limited`). Read at boot
   * to seed the request policy and again on every settings save to reconfigure it live. Stays a
   * standalone single-SELECT accessor (the boot/reconfigure callers want just the quota); `getDto()`
   * maps the same sanitizer off the row it already fetched.
   */
  async getDefaultQuota(): Promise<DefaultQuota> {
    const row = await this.db.query.appSettings.findFirst({ where: eq(appSettings.id, SINGLETON_ID) });
    return this.sanitizeQuota(row);
  }

  /**
   * Narrow the raw quota columns into a `DefaultQuota` that ALWAYS satisfies `defaultQuotaSchema`,
   * so a legacy / hand-edited / incoherent row can never 502 the masked Settings GET (which reuses
   * that schema) nor seed the boot request policy with a value the write path would reject. The
   * CHECK constraints make incoherence unreachable through the app, but this still degrades sanely:
   * `windowDays` falls back to 30 on an out-of-set value; a `limited` mode with a missing/non-positive
   * limit (or any unrecognized mode) degrades to `unlimited` rather than emitting an illegal union
   * member. A healthy fresh-DB row (`limited`/10/30) passes through unchanged.
   */
  private sanitizeQuota(
    row:
      | { defaultQuotaMode: string; defaultQuotaLimit: number | null; defaultQuotaWindowDays: number }
      | undefined,
  ): DefaultQuota {
    const window = quotaWindowDaysSchema.safeParse(row?.defaultQuotaWindowDays);
    const windowDays = window.success ? window.data : 30;
    const limit = row?.defaultQuotaLimit ?? null;
    if (row?.defaultQuotaMode === 'limited' && limit !== null && Number.isInteger(limit) && limit > 0) {
      return { mode: 'limited', limit, windowDays };
    }
    return { mode: 'unlimited', windowDays };
  }

  /**
   * Decrypt a stored secret (enc blob, or tolerate legacy plaintext) → plaintext|null.
   * A blob that fails to decrypt (the at-rest key changed — e.g. SESSION_SECRET rotated
   * with no SETTINGS_KEY) returns null AND logs a loud WARN, so a connector silently going
   * dark is diagnosable rather than indistinguishable from "never configured".
   */
  private reveal(value: unknown, field: string): string | null {
    // A non-string / empty secret (a corrupt blob whose value survived the envelope schema as
    // `unknown`) is treated as unconfigured — same outcome as an undecryptable one, but SILENT
    // (no per-read warn: getDto()/getNotificationsConfig() call reveal()/hostHint() more than once
    // per row). This also stops `codec.isEncrypted(value)` (a `.startsWith`) throwing on a non-string.
    if (!isUsableSecret(value)) return null;
    if (!this.codec.isEncrypted(value)) return value; // legacy plaintext, tolerated
    const plain = this.codec.decrypt(value);
    if (plain === null) {
      this.logger.warn(
        { field },
        'connector secret could not be decrypted (settings key changed?) — treating this connector as unconfigured',
      );
    }
    return plain;
  }

  /** Narratorr client config (decrypted). null when unconfigured or the key can't be read. */
  async getNarratorrConfig(): Promise<{ url: string; apiKey: string } | null> {
    const c = await this.getStored();
    if (!c.narratorr) return null;
    const apiKey = this.reveal(c.narratorr.apiKey, 'narratorr.apiKey');
    if (!apiKey) return null;
    // The full base URL is stored directly (the user types it); NarratorrClient consumes
    // { url, apiKey } as-is.
    return { url: c.narratorr.url, apiKey };
  }

  /** Notifications config (decrypted) in the shape buildNotifier expects. */
  async getNotificationsConfig(): Promise<NotificationsConfig> {
    const c = await this.getStored();
    return { publicUrl: c.publicUrl, notifiers: c.notifiers.map((n) => this.toRuntimeNotifier(n)) };
  }

  /**
   * Build a narratorr runtime config from an UNSAVED candidate (the Settings "Test"
   * path), resolving an omitted/unchanged apiKey against the stored, decrypted secret.
   * Mirrors getNarratorrConfig() but reads the candidate's url instead of the stored one.
   * NEVER writes — the stored secret is only decrypted in-memory. Returns null when the
   * candidate is absent/blank or no usable key resolves (→ clean "not configured").
   */
  async buildCandidateNarratorrConfig(
    candidate: TestConnectorBody['narratorr'],
  ): Promise<{ url: string; apiKey: string } | null> {
    if (!candidate) return null;
    const stored = await this.getStored();
    const apiKey = this.resolveCandidateSecret(candidate.apiKey, stored.narratorr?.apiKey, 'narratorr.apiKey');
    if (!apiKey) return null;
    return { url: candidate.url, apiKey };
  }

  /**
   * Resolve a candidate secret for the read-only Test path → PLAINTEXT for runtime use:
   * `undefined` (unchanged) → the stored secret, decrypted in-memory; `''` → none; a typed
   * value → used as-is. Distinct from resolveSecret() (the persistence path, which ENCRYPTS):
   * this never touches the DB and yields plaintext a live probe can use immediately.
   */
  private resolveCandidateSecret(
    provided: string | undefined,
    storedEncrypted: string | null | undefined,
    field: string,
  ): string | null {
    if (provided === undefined) return this.reveal(storedEncrypted ?? null, field);
    if (provided === '') return null;
    return provided;
  }

  /**
   * Masked view for the Settings page — secrets become has* booleans / host hints. Reads the
   * singleton row ONCE and maps both the connector DTO and the (sanitized) default-quota DTO off
   * it — the connector blob and the quota columns live on the same row, so the most-called settings
   * read needs a single SELECT, not one per concern.
   */
  async getDto(): Promise<ConnectorSettingsDto> {
    const row = await this.db.query.appSettings.findFirst({ where: eq(appSettings.id, SINGLETON_ID) });
    const c = this.connectorsFrom(row);
    return {
      publicUrl: c.publicUrl,
      narratorr: c.narratorr
        ? {
            url: c.narratorr.url,
            hasApiKey: isUsableSecret(c.narratorr.apiKey),
          }
        : null,
      notifiers: c.notifiers.map((n) => this.toNotifierDto(n)),
      defaultQuota: this.sanitizeQuota(row),
      requesterEmailWarning: await this.computeRequesterEmailWarning(c),
      // Resolved at READ time against the live decrypted notifiers (no cross-write coordination:
      // notifier CRUD never touches the stored pair — see resolveKindleSender in kindle-sender.ts).
      kindleSender: resolveKindleSender(c.kindleSender, c.notifiers.map((n) => this.toRuntimeNotifier(n))),
    };
  }

  /**
   * The admin-visible requester-email warning (issue #50): true IFF one or more users have opted
   * into a requester notification but no usable email-notifier SMTP source exists — those opt-ins
   * would deliver nothing. Shares BOTH halves of "would a send fire?" with the send path so the
   * warning can't disagree with it: the opt-in half via {@link hasNotifyOn} (the single opt-in
   * predicate the availability sweep also derives from — `request.service.ts`), and the
   * SMTP-source half via `selectEmailSource` over the decrypted runtime notifiers. Skips the
   * source check when nobody has opted in.
   */
  private async computeRequesterEmailWarning(c: StoredConnectors): Promise<boolean> {
    // `notify_on <> '[]'` is a COARSE, non-authoritative prefilter — it only drops rows equal to
    // the literal '[]' (which `hasNotifyOn` would reject anyway), so it can never exclude a
    // genuinely opted-in row. The opt-in DECISION lives solely in `hasNotifyOn`, run over the
    // candidate rows in JS: a corrupt/legacy value like `["bogus"]` is `<> '[]'` here but
    // sanitizes to `[]`, so it must NOT fire the warning (mirroring that it never sends).
    const candidates = await this.db
      .select({ notifyOn: users.notifyOn })
      .from(users)
      .where(sql`${users.notifyOn} <> '[]'`);
    if (!candidates.some((r) => hasNotifyOn(r.notifyOn))) return false;
    // Someone opted in — warn only when there's no usable email source to deliver through.
    return selectEmailSource({ publicUrl: c.publicUrl, notifiers: c.notifiers.map((n) => this.toRuntimeNotifier(n)) }) === null;
  }

  /**
   * Persist a connector + default-quota save. The connector blob and the quota columns live on the
   * same singleton row, and a PUT body can carry both, so they're written in ONE atomic `UPDATE`
   * with conditional columns — no half-applied save where (say) the connector change is durable but
   * the quota write fails and `reconfigure()` never runs. `resolveNarratorr` (which can 400 on a
   * missing required key) runs BEFORE the write, so a rejected body never touches the row.
   *
   * Per field: publicUrl omitted → keep, null → clear, value → set; narratorr omitted → keep, null →
   * clear, object → resolve & set (the notifier list is untouched by this body). The `connectors`
   * column is written only when a connector field is present; the quota columns only when
   * `defaultQuota` is present, in which case all three mode/limit/window columns are written together
   * from the supplied mode (the mode-first editor always sends `windowDays`). The whole object
   * omitted → quota columns untouched. `limited` writes the positive limit; `unlimited` nulls it,
   * keeping the row CHECK-coherent.
   */
  async update(body: UpdateConnectorSettingsBody): Promise<StoredConnectors> {
    const cur = await this.getStored();
    const next: StoredConnectors = { ...cur };

    const hasConnectorFields =
      body.publicUrl !== undefined || body.narratorr !== undefined || body.kindleSender !== undefined;
    if (body.publicUrl !== undefined) next.publicUrl = body.publicUrl;
    if (body.narratorr !== undefined) next.narratorr = this.resolveNarratorr(body.narratorr, cur.narratorr);
    if (body.kindleSender !== undefined) next.kindleSender = this.resolveKindleSender(body.kindleSender, cur);

    const q = body.defaultQuota;
    const [row] = await this.db
      .update(appSettings)
      .set({
        ...(hasConnectorFields && { connectors: next }),
        ...(q !== undefined && {
          defaultQuotaMode: q.mode,
          defaultQuotaLimit: q.mode === 'limited' ? q.limit : null,
          defaultQuotaWindowDays: q.windowDays,
        }),
        updatedAt: new Date(),
      })
      .where(eq(appSettings.id, SINGLETON_ID))
      .returning();
    // Guard a silent no-op: SettingsService.ensure() creates the singleton at boot, so a zero-row
    // match means the row vanished and `next` would be a lie.
    if (!row) throw new Error('app_settings singleton missing — settings update did not persist');
    return next;
  }

  // ---- Notifier CRUD --------------------------------------------------------

  /** Create a notifier (required secrets enforced — no stored value to fall back to). */
  async createNotifier(body: CreateNotifierBody): Promise<StoredNotifier> {
    const def = NOTIFIER_REGISTRY[body.type];
    const config = this.resolveNotifierConfig(def, this.parseConfig(def, body.config), undefined);
    const notifier: StoredNotifier = {
      id: publicId('nf'),
      name: body.name,
      type: body.type,
      events: body.events,
      config,
    };
    const cur = await this.getStored();
    await this.persist({ ...cur, notifiers: [...cur.notifiers, notifier] });
    return notifier;
  }

  /** Edit a notifier by id — secrets are omit-to-keep against the stored config (by id). */
  async updateNotifier(id: string, body: UpdateNotifierBody): Promise<StoredNotifier> {
    const cur = await this.getStored();
    const idx = cur.notifiers.findIndex((n) => n.id === id);
    if (idx === -1) throw notFound('Notifier not found.');
    const existing = cur.notifiers[idx]!;
    // Don't launder an UNKNOWN (out-of-registry) stored type into a known one: that path would
    // silently discard the old encrypted config. An unknown notifier is disabled + deletable
    // only — its type is locked. (`body.type` is always a known registry key, so any update to
    // an unknown row is necessarily a type change.) The stored row is left untouched.
    if (!isKnownNotifierType(existing.type) && existing.type !== body.type) {
      throw badRequest('NOTIFIER_TYPE_LOCKED', 'Cannot change the type of an unrecognized notifier — delete it instead.');
    }
    const def = NOTIFIER_REGISTRY[body.type];
    // If the type changed, the stored secret has a different shape → no omit-to-keep base, so a
    // required secret of the new type must be supplied. Same type → omit-to-keep against the
    // stored config (but explicitly clearing a required secret is still rejected — see resolveNotifierConfig).
    const existingConfig = existing.type === body.type ? existing.config : undefined;
    const config = this.resolveNotifierConfig(def, this.parseConfig(def, body.config), existingConfig);
    const updated: StoredNotifier = {
      id,
      name: body.name,
      type: body.type,
      events: body.events,
      config,
    };
    const notifiers = [...cur.notifiers];
    notifiers[idx] = updated;
    await this.persist({ ...cur, notifiers });
    return updated;
  }

  async deleteNotifier(id: string): Promise<void> {
    const cur = await this.getStored();
    const notifiers = cur.notifiers.filter((n) => n.id !== id);
    if (notifiers.length === cur.notifiers.length) throw notFound('Notifier not found.');
    await this.persist({ ...cur, notifiers });
  }

  /**
   * Build a runtime (plaintext) notifier config from an UNSAVED candidate (the notifier
   * "Test" path). `id` present (edit) → omit-to-keep secrets against the stored notifier;
   * absent (create) → secrets must be provided. NEVER writes.
   */
  async buildCandidateNotifier(
    body: Pick<NotifierTestBody, 'type' | 'config' | 'id'>,
  ): Promise<{ type: NotifierType; config: Record<string, unknown> }> {
    const def = NOTIFIER_REGISTRY[body.type];
    const parsed = this.parseConfig(def, body.config);
    const stored = body.id ? (await this.getStored()).notifiers.find((n) => n.id === body.id) : undefined;
    const existing = stored && stored.type === body.type ? stored.config : undefined;
    return { type: body.type, config: this.buildCandidateNotifierConfig(def, parsed, existing) };
  }

  // ---- Generic, registry-driven notifier helpers ----------------------------

  /**
   * Reveal a stored notifier into the runtime shape (secrets decrypted; unknown type passes opaque).
   * Events are sanitized via `safeEvents()` on BOTH branches — a non-iterable stored value (e.g.
   * `events: 42`) would otherwise reach `new Set(nf.events)` in `buildNotifier` and crash-loop boot.
   * This mirrors the DTO path's degrade so the runtime and DTO surfaces agree on a corrupt row.
   */
  private toRuntimeNotifier(n: StoredNotifier): RuntimeNotifier {
    const events = this.safeEvents(n);
    if (!isKnownNotifierType(n.type)) return { ...n, events, config: n.config };
    return { ...n, events, config: this.revealNotifierConfig(NOTIFIER_REGISTRY[n.type], n.config) };
  }

  /**
   * Mask a stored notifier into its DTO — known → masked config; unknown → deletable, no config.
   * NEVER-BRICK: a single row whose config OR events fail their response schema must not 500 the
   * whole Settings GET (the admin couldn't even load the page to delete the offending row). Both
   * independently-validated fields degrade: a config that fails masking falls back to the
   * disabled/deletable UnknownNotifierDto; events that fail validation become `events: []`. Each
   * failure logs a WARN with the notifier id, mirroring the buildOne skip-with-warn at runtime.
   */
  private toNotifierDto(n: StoredNotifier): NotifierDto {
    // Events validate against the response schema on BOTH the known and unknown DTOs, so make
    // them response-safe before either branch.
    const events = this.safeEvents(n);

    if (isKnownNotifierType(n.type)) {
      const config = this.tryMaskNotifierConfig(NOTIFIER_REGISTRY[n.type], n.config);
      if (config !== null) {
        return { id: n.id, name: n.name, type: n.type, events, config };
      }
      // Masked config failed its schema → degrade to the unknown DTO (deletable, no config) so
      // the row stays visible and removable instead of bricking the response.
      this.logger.warn(
        { notifier: n.id, type: n.type },
        'notifier config could not be masked (malformed stored config) — degrading to a deletable row',
      );
    }
    return { id: n.id, name: n.name, type: n.type, events, unknown: true };
  }

  /** Response-safe events: valid keys pass through; a malformed set degrades to [] + WARN. */
  private safeEvents(n: StoredNotifier): NotificationEvent[] {
    const result = z.array(notificationEventSchema).safeParse(n.events);
    if (result.success) return result.data;
    this.logger.warn(
      { notifier: n.id, type: n.type },
      'notifier events failed the schema — emitting events: [] so the Settings GET still loads',
    );
    return [];
  }

  /** Decrypt each secret field; copy non-secrets through. */
  private revealNotifierConfig(def: NotifierTypeDef, stored: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const f of def.fields) {
      const sf = def.secretFields.find((s) => s.field === f.key);
      out[f.key] = sf ? this.reveal(stored[f.key], `${def.type}.${f.key}`) : stored[f.key];
    }
    return out;
  }

  /**
   * Drop secret values → has* booleans (+ host hint for capability URLs); copy non-secrets.
   * Returns null (rather than throwing) when the masked shape fails the type's masked schema —
   * a malformed stored config — so the caller can degrade the row instead of bricking the GET.
   */
  private tryMaskNotifierConfig(def: NotifierTypeDef, stored: Record<string, unknown>): Record<string, unknown> | null {
    const out: Record<string, unknown> = {};
    for (const f of def.fields) {
      const sf = def.secretFields.find((s) => s.field === f.key);
      if (sf) {
        out[sf.maskedField] = isUsableSecret(stored[f.key]);
        if (sf.hintField) out[sf.hintField] = this.hostHint(stored[f.key]);
      } else {
        out[f.key] = stored[f.key];
      }
    }
    const result = def.maskedConfigSchema.safeParse(out);
    return result.success ? (result.data as Record<string, unknown>) : null;
  }

  /**
   * Host hint for a capability-URL secret — `hooks.slack.com/…`, never the full URL.
   * Decrypts to read the host (GET never throws: reveal returns null + warns on failure),
   * falling back to "configured" when the value is present but can't be parsed/decrypted.
   */
  private hostHint(value: unknown): string | null {
    if (typeof value !== 'string' || !value) return null;
    const plain = this.reveal(value, 'notifier.capabilityUrl');
    if (!plain) return 'configured';
    try {
      return `${new URL(plain).host}/…`;
    } catch {
      return 'configured';
    }
  }

  /**
   * Build the stored config: encrypt secrets, store non-secrets. Required secrets are enforced
   * AFTER resolution, symmetrically on create and update: omitting one (`undefined`) keeps the
   * existing encrypted value (so a required secret survives an unrelated edit), but explicitly
   * clearing one (`''`, which resolves to `null`) on a `sf.required` field is rejected — a
   * required secret can never be left empty-but-enabled (which would be unbuildable at runtime).
   */
  private resolveNotifierConfig(
    def: NotifierTypeDef,
    parsed: Record<string, unknown>,
    existing: Record<string, unknown> | undefined,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const f of def.fields) {
      const sf = def.secretFields.find((s) => s.field === f.key);
      if (sf) {
        const resolved = this.resolveSecret(parsed[f.key] as string | undefined, existing?.[f.key] as string | null | undefined);
        if (sf.required && !resolved) {
          throw badRequest('NOTIFIER_SECRET_REQUIRED', `${def.label} requires ${f.label}.`);
        }
        out[f.key] = resolved;
      } else {
        out[f.key] = parsed[f.key] ?? null;
      }
    }
    return out;
  }

  /** Build a runtime (plaintext) config from a candidate — secrets omit-to-keep by id. */
  private buildCandidateNotifierConfig(
    def: NotifierTypeDef,
    parsed: Record<string, unknown>,
    existing: Record<string, unknown> | undefined,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const f of def.fields) {
      const sf = def.secretFields.find((s) => s.field === f.key);
      out[f.key] = sf
        ? this.resolveCandidateSecret(parsed[f.key] as string | undefined, existing?.[f.key] as string | null | undefined, `${def.type}.${f.key}`)
        : (parsed[f.key] ?? null);
    }
    return out;
  }

  /** Validate the type-specific config against the registry schema → 400 on failure. */
  private parseConfig(def: NotifierTypeDef, raw: unknown): Record<string, unknown> {
    const result = def.configSchema.safeParse(raw);
    if (!result.success) {
      const first = result.error.issues[0];
      throw badRequest(
        'NOTIFIER_CONFIG_INVALID',
        first ? `${first.path.join('.') || 'config'}: ${first.message}` : 'Invalid notifier config.',
      );
    }
    return result.data as Record<string, unknown>;
  }

  /**
   * Resolve a secret field on update: a non-empty value is encrypted; an empty string
   * clears it; `undefined` keeps the existing (already-encrypted) value. This is what
   * lets the UI send `••••` (omit) for an unchanged secret without ever seeing it.
   * Request input is ALWAYS treated as plaintext (never sniffed for an `enc:` prefix) so a
   * literal "enc:v1:…" submitted by a client can't be stored as if it were ciphertext.
   */
  private resolveSecret(provided: string | undefined, existing: string | null | undefined): string | null {
    if (provided === undefined) return existing ?? null;
    if (provided === '') return null;
    return this.codec.encrypt(provided);
  }

  private resolveNarratorr(
    body: NonNullable<UpdateConnectorSettingsBody['narratorr']> | null,
    cur: StoredConnectors['narratorr'],
  ): StoredConnectors['narratorr'] {
    if (body === null) return null;
    const apiKey = this.resolveSecret(body.apiKey, cur?.apiKey);
    if (!apiKey) throw badRequest('NARRATORR_KEY_REQUIRED', 'Narratorr requires an API key.');
    return { url: body.url, apiKey };
  }

  /**
   * Resolve a Kindle-sender selection (issue #143) into the stored pair. The body carries ONLY the
   * notifier id; `confirmedFrom` is DERIVED here from that notifier's live `from`, so the
   * confirmation can never be spoofed by a client and re-sending an unchanged id is a meaningful
   * write (the reconfirm out of `sender-changed`). Runs BEFORE the single UPDATE — like
   * `resolveNarratorr` — so a rejected selection leaves the whole row (connector blob AND the
   * quota columns) untouched, even in a mixed body. A selection that can't be confirmed is a
   * `400 KINDLE_SENDER_INVALID` with a CASE-SPECIFIC message; there is deliberately no
   * fall-through to another email notifier.
   */
  private resolveKindleSender(
    body: NonNullable<UpdateConnectorSettingsBody['kindleSender']> | null,
    cur: StoredConnectors,
  ): StoredConnectors['kindleSender'] {
    if (body === null) return null;
    // Confirm against the DECRYPTED runtime notifiers — the same view the read-time resolver and
    // the send path use, so a write can't succeed into a state `getDto()` would call invalid.
    const confirmation = confirmSenderMailbox(body.notifierId, cur.notifiers.map((n) => this.toRuntimeNotifier(n)));
    if ('failure' in confirmation) {
      throw badRequest('KINDLE_SENDER_INVALID', KINDLE_SENDER_INVALID_MESSAGE[confirmation.failure]);
    }
    return { notifierId: body.notifierId, confirmedFrom: confirmation.mailbox };
  }

  /**
   * Persist the whole connector blob. Guard against a silent no-op: if the singleton row
   * is missing, the UPDATE matches zero rows and `next` would be a lie. SettingsService
   * .ensure() creates it at boot, so this should never fire — but assert it.
   */
  private async persist(next: StoredConnectors): Promise<void> {
    const [row] = await this.db
      .update(appSettings)
      .set({ connectors: next, updatedAt: new Date() })
      .where(eq(appSettings.id, SINGLETON_ID))
      .returning();
    if (!row) throw new Error('app_settings singleton missing — connector update did not persist');
  }
}
