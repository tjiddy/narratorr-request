import type { NotificationChannel, SendContext } from '../types.js';

// Recipe vendored from narratorr's src/core/notifiers/pushover.ts (develop), rewired to our
// render() output and throw-on-failure contract. Both the app token and user key are
// secrets (sent in the body) — redact() scrubs them from any Test/log line.

export interface PushoverConfig {
  appToken: string;
  userKey: string;
}

// Pushover field limits (https://pushover.net/api#limits).
const TITLE_MAX = 250;
const MESSAGE_MAX = 1024;

const trunc = (s: string, max: number): string => (s.length > max ? s.slice(0, max) : s);

export class PushoverChannel implements NotificationChannel {
  readonly name = 'pushover';
  // Both the app token and user key are secrets (sent in the body) — exposed for dispatcher-log redaction.
  readonly secrets: readonly string[];
  constructor(private readonly cfg: PushoverConfig) {
    this.secrets = [cfg.appToken, cfg.userKey];
  }

  async send({ message }: SendContext): Promise<void> {
    const body = {
      token: this.cfg.appToken,
      user: this.cfg.userKey,
      title: trunc(message.title, TITLE_MAX),
      message: trunc(message.url ? `${message.body}\n${message.url}` : message.body, MESSAGE_MAX),
      priority: 0,
    };

    const res = await fetch('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      // Refuse redirects — see ntfy adapter. A 307/308 would replay this body, token and
      // user key included, at whatever host the response named.
      redirect: 'error',
      // Bound the call — see ntfy adapter.
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Pushover responded ${res.status}`);
  }
}
