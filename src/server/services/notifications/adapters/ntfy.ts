import type { NotificationChannel, SendContext } from '../types.js';

export interface NtfyConfig {
  /** Base URL, no trailing slash — e.g. https://ntfy.sh or a self-hosted instance. */
  url: string;
  topic: string;
  /** Optional access token for protected topics (sent as a bearer). */
  token: string | null;
  /** Optional ntfy priority: 1..5 or min/low/default/high/max. */
  priority: string | null;
}

/**
 * ntfy (https://ntfy.sh) publish: POST the message body to `<url>/<topic>`, with
 * metadata in headers. Header values are ASCII-safe (the static title + URLs); the
 * UTF-8 message text rides in the body. Action buttons (Approve/Deny) are a future
 * add via the `Actions` header once the tokened endpoints exist.
 */
export class NtfyChannel implements NotificationChannel {
  readonly name = 'ntfy';
  // The access token (when set) is the secret — exposed for dispatcher-log redaction.
  readonly secrets: readonly string[];
  constructor(private readonly cfg: NtfyConfig) {
    this.secrets = cfg.token ? [cfg.token] : [];
  }

  async send({ payload, message }: SendContext): Promise<void> {
    const headers: Record<string, string> = { Title: message.title };
    if (this.cfg.token) headers.Authorization = `Bearer ${this.cfg.token}`;
    if (this.cfg.priority) headers.Priority = this.cfg.priority;
    if (message.url) headers.Click = message.url;
    // Branch on DATA PRESENCE (a request-shaped payload's coverUrl), not the event literal,
    // so a future request-shaped event (e.g. request.failed, #60) attaches its cover with no
    // edit here — mirrors the Discord adapter's coverUrl() guard. user.pending has no request.
    if ('request' in payload && payload.request.coverUrl) {
      headers.Icon = payload.request.coverUrl;
    }

    const res = await fetch(`${this.cfg.url}/${this.cfg.topic}`, {
      method: 'POST',
      headers,
      body: message.body,
      // Never re-issue the request at a host the destination named — a followed 30x can hand
      // a credential (header or replayed body) to a party the admin never configured. Unlike
      // the narratorr client there is no error taxonomy to map into, so the raw fetch
      // rejection surfaces to the dispatcher/Test sink like any other network failure.
      redirect: 'error',
      // Bound the call — notify() fires per request, so a black-holing endpoint
      // must not accumulate hung sockets/promises over the app's lifetime.
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`ntfy responded ${res.status}`);
  }
}
