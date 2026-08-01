import type { NotificationChannel, NotificationPayload, SendContext } from '../types.js';

// Recipe vendored from narratorr's src/core/notifiers/discord.ts (develop), rewired to our
// render() output ({ title, body, url }) and our throw-on-failure dispatcher contract.

export interface DiscordConfig {
  webhookUrl: string;
  includeCover: boolean;
}

// Embed accent colour per event — blue for a new request, red for a failed one, amber
// for a pending user. Kept a full Record so the exhaustiveness check guards future events.
const EVENT_COLOR: Record<NotificationPayload['event'], number> = {
  'request.created': 0x3498db,
  'request.failed': 0xe74c3c,
  'user.pending': 0xf1c40f,
};
const DEFAULT_COLOR = 0x3498db;

// Discord embed limits (https://discord.com/developers/docs/resources/channel#embed-limits).
const TITLE_MAX = 256;
const DESCRIPTION_MAX = 4096;

const trunc = (s: string, max: number): string => (s.length > max ? s.slice(0, max) : s);

/**
 * The cover URL if the payload carries one. Branch on DATA PRESENCE (a request-shaped
 * payload's `coverUrl`), not on the event literal, so a future request-shaped event
 * (e.g. request.failed, issue #60) attaches its cover with no change here.
 */
function coverUrl(payload: NotificationPayload): string | null {
  return 'request' in payload ? payload.request.coverUrl : null;
}

export class DiscordChannel implements NotificationChannel {
  readonly name = 'discord';
  // The webhook URL is the capability secret — exposed for dispatcher-log redaction.
  readonly secrets: readonly string[];
  constructor(private readonly cfg: DiscordConfig) {
    this.secrets = [cfg.webhookUrl];
  }

  async send({ payload, message }: SendContext): Promise<void> {
    const embed: Record<string, unknown> = {
      title: trunc(message.title, TITLE_MAX),
      description: trunc(message.body, DESCRIPTION_MAX),
      color: EVENT_COLOR[payload.event] ?? DEFAULT_COLOR,
      footer: { text: 'narratorr-requests' },
    };
    if (message.url) embed.url = message.url;
    const cover = coverUrl(payload);
    if (this.cfg.includeCover && cover) embed.thumbnail = { url: cover };

    const res = await fetch(this.cfg.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // allowed_mentions:{parse:[]} — a book titled "@everyone"/"@here" must never ping the server.
      body: JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } }),
      // Refuse redirects — see ntfy adapter.
      redirect: 'error',
      // Bound the call — see ntfy adapter: a hung endpoint must not leak sockets.
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Discord responded ${res.status}`);
  }
}
