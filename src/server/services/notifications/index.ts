import { z } from 'zod';
import { Notifier } from './notifier.service.js';
import { NtfyChannel } from './adapters/ntfy.js';
import { EmailChannel } from './adapters/email.js';
import { WebhookChannel } from './adapters/webhook.js';
import { DiscordChannel } from './adapters/discord.js';
import { SlackChannel } from './adapters/slack.js';
import { TelegramChannel } from './adapters/telegram.js';
import { PushoverChannel } from './adapters/pushover.js';
import { GotifyChannel } from './adapters/gotify.js';
import { NOTIFIER_TYPES, type NotifierType } from '../../../shared/notifier-registry.js';
import type { NotificationEvent } from '../../../shared/notification-events.js';
import type {
  NotificationChannel,
  NotifierLogger,
  NotificationsConfig,
  RuntimeNotifier,
  SendContext,
} from './types.js';

// =============================================================================
// Adapter map — the single owner of "a runtime (decrypted) config becomes a live
// channel", keyed by notifier type. Replaces the old hardcoded buildChannel switch +
// ALL_CHANNELS list: adding a future type is a new registry entry + a new adapter here,
// no edits to the dispatch wiring. Each builder validates the runtime config with a
// per-type schema (the runtime-plaintext shape) and throws on a bad/undecryptable
// config — buildNotifier catches that and skips the notifier (degrades gracefully).
// =============================================================================

const ntfyRuntimeSchema = z.object({
  url: z.string(),
  topic: z.string(),
  token: z.string().nullable(),
  priority: z.string().nullable(),
});
// Exported so the requester-email path (issue #50) selects its SMTP source with the SAME
// runtime predicate the dispatcher's adapter map uses — `user`/`pass` nullable, so a
// passwordless / open-relay email notifier is usable. Do NOT re-validate a source against the
// registry WRITE `configSchema` (its `pass` is optional and a different shape); that would
// wrongly reject a healthy passwordless source. See requester-email.ts / AC9.
export const emailRuntimeSchema = z.object({
  host: z.string(),
  port: z.number(),
  secure: z.boolean(),
  user: z.string().nullable(),
  pass: z.string().nullable(),
  from: z.string(),
  to: z.string(),
});
export type EmailRuntimeConfig = z.infer<typeof emailRuntimeSchema>;
const webhookRuntimeSchema = z.object({ url: z.string().min(1) });
const discordRuntimeSchema = z.object({ webhookUrl: z.string().min(1), includeCover: z.boolean().default(true) });
const slackRuntimeSchema = z.object({ webhookUrl: z.string().min(1) });
const telegramRuntimeSchema = z.object({ botToken: z.string().min(1), chatId: z.string().min(1) });
const pushoverRuntimeSchema = z.object({ appToken: z.string().min(1), userKey: z.string().min(1) });
const gotifyRuntimeSchema = z.object({ serverUrl: z.string().min(1), appToken: z.string().min(1) });

type AdapterBuilder = (config: Record<string, unknown>) => NotificationChannel;

const ADAPTERS: Record<NotifierType, AdapterBuilder> = {
  ntfy: (c) => new NtfyChannel(ntfyRuntimeSchema.parse(c)),
  email: (c) => new EmailChannel(emailRuntimeSchema.parse(c)),
  webhook: (c) => new WebhookChannel(webhookRuntimeSchema.parse(c)),
  discord: (c) => new DiscordChannel(discordRuntimeSchema.parse(c)),
  slack: (c) => new SlackChannel(slackRuntimeSchema.parse(c)),
  telegram: (c) => new TelegramChannel(telegramRuntimeSchema.parse(c)),
  pushover: (c) => new PushoverChannel(pushoverRuntimeSchema.parse(c)),
  gotify: (c) => new GotifyChannel(gotifyRuntimeSchema.parse(c)),
};

/**
 * Build a live channel for a known notifier type from its runtime (decrypted) config.
 * Returns null for an unknown type. Used by the Settings notifier "Test" endpoint; the
 * dispatcher (buildNotifier) uses the same adapter map. Throws if the config fails the
 * type's runtime schema (e.g. a required secret that wouldn't decrypt).
 */
export function buildNotifierChannel(type: string, config: Record<string, unknown>): NotificationChannel | null {
  // Own-property check (not `ADAPTERS[type]` directly): a stored `type` is a lenient string, so a
  // malformed row of `__proto__`/`constructor`/`toString` must NOT resolve a prototype member as a
  // "builder" (→ "builder is not a function"). An inherited key degrades to an unknown type → null.
  if (!Object.hasOwn(ADAPTERS, type)) return null;
  return ADAPTERS[type as NotifierType](config);
}

/**
 * A channel wrapper that delivers ONLY events in the notifier's `events` set — the
 * per-notifier event routing. The dispatcher fans every event to every channel; this
 * filter drops the ones a given notifier didn't subscribe to.
 */
class EventFilteredChannel implements NotificationChannel {
  constructor(
    private readonly inner: NotificationChannel,
    private readonly events: ReadonlySet<NotificationEvent>,
    readonly name: string,
  ) {}

  /** Forward the wrapped channel's secrets so the dispatcher can redact them from a log line. */
  get secrets(): readonly string[] {
    return this.inner.secrets ?? [];
  }

  async send(ctx: SendContext): Promise<void> {
    if (this.events.has(ctx.payload.event)) await this.inner.send(ctx);
  }
}

function buildOne(nf: RuntimeNotifier, log: NotifierLogger): NotificationChannel | null {
  let inner: NotificationChannel | null;
  try {
    inner = buildNotifierChannel(nf.type, nf.config);
  } catch (err) {
    // A bad/undecryptable runtime config must not brick the whole dispatcher — skip it.
    log.warn({ notifier: nf.id, type: nf.type, err }, 'notifier could not be built — skipping');
    return null;
  }
  if (!inner) {
    // Unknown type (not in the registry) — defensively skipped at build.
    log.warn({ notifier: nf.id, type: nf.type }, 'unknown notifier type — skipping');
    return null;
  }
  return new EventFilteredChannel(inner, new Set(nf.events), `${nf.type}:${nf.name}`);
}

/**
 * Assemble the dispatcher from the decrypted notifier list. Each notifier of a known type
 * becomes an event-filtered channel; unknown / unbuildable ones are skipped. An empty
 * result yields a no-op Notifier — `notify()` returns immediately.
 */
export function buildNotifier(cfg: NotificationsConfig, log: NotifierLogger): Notifier {
  const channels = cfg.notifiers
    .map((nf) => buildOne(nf, log))
    .filter((c): c is NotificationChannel => c !== null);
  if (channels.length > 0) {
    log.info({ channels: channels.map((c) => c.name) }, 'notifications enabled');
  }
  return new Notifier(channels, cfg.publicUrl, log);
}

export { NOTIFIER_TYPES };
export { Notifier } from './notifier.service.js';
export { render } from './render.js';
export { redact } from './redact.js';
export type {
  NotificationEvent,
  NotificationPayload,
  NotificationsConfig,
  RuntimeNotifier,
  NotificationChannel,
  SendContext,
} from './types.js';
