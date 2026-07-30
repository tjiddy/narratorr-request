import type { NotificationChannel, SendContext } from '../types.js';

export interface WebhookConfig {
  url: string;
}

/**
 * Generic JSON webhook. The body carries a `content` string so the SAME URL works
 * as a Discord webhook (Discord renders `content` and ignores the extra fields),
 * while a generic consumer gets the structured event/request/requester data.
 */
export class WebhookChannel implements NotificationChannel {
  readonly name = 'webhook';
  // The webhook URL is a capability secret (may carry a token) — exposed for dispatcher-log
  // redaction. Pattern scrubbing only covers Discord/Slack hosts; an arbitrary hook URL needs
  // this exact-match value so it never lands in the log line raw.
  readonly secrets: readonly string[];
  constructor(private readonly cfg: WebhookConfig) {
    this.secrets = [cfg.url];
  }

  async send({ payload, message }: SendContext): Promise<void> {
    const content = [message.title, message.body, message.url].filter(Boolean).join('\n');
    // `content` works for Discord (it renders that and ignores the rest); the
    // event-specific fields give a generic consumer the structured data.
    // Branch on DATA PRESENCE, not the event literal, so any request-shaped event
    // (request.created, request.failed, …) serializes its request/requester payload
    // with no further edits here. A request.failed payload also carries a `reason`.
    const structured =
      'request' in payload
        ? {
            request: payload.request,
            requester: payload.requester,
            ...('reason' in payload && { reason: payload.reason }),
          }
        : { user: payload.user };
    const res = await fetch(this.cfg.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content, event: payload.event, ...structured, url: message.url }),
      // Refuse redirects — see ntfy adapter.
      redirect: 'error',
      // Bound the call — see ntfy adapter: a hung endpoint must not leak sockets.
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`webhook responded ${res.status}`);
  }
}
