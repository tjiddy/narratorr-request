import type { NotificationChannel, SendContext } from '../types.js';

// Recipe vendored from narratorr's src/core/notifiers/gotify.ts (develop), rewired to our
// render() output and throw-on-failure contract. The server URL is admin-configured (NOT
// secret); the app token authenticates via the X-Gotify-Key header and IS a secret.

export interface GotifyConfig {
  serverUrl: string;
  appToken: string;
}

export class GotifyChannel implements NotificationChannel {
  readonly name = 'gotify';
  // The app token (X-Gotify-Key header) is the secret — exposed for dispatcher-log redaction.
  // The server URL is admin-configured and NOT secret, so it is not listed.
  readonly secrets: readonly string[];
  constructor(private readonly cfg: GotifyConfig) {
    this.secrets = [cfg.appToken];
  }

  async send({ message }: SendContext): Promise<void> {
    // Normalize the trailing slash so a pasted base ("https://gotify/") doesn't double it.
    const url = `${this.cfg.serverUrl.replace(/\/+$/, '')}/message`;
    const body = {
      title: message.title,
      message: message.url ? `${message.body}\n${message.url}` : message.body,
      priority: 5,
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Gotify-Key': this.cfg.appToken },
      body: JSON.stringify(body),
      // A redirect must fail rather than replay the app token at the host the destination
      // chose: the WHATWG cross-origin stripping rule covers `Authorization`, not our custom
      // `X-Gotify-Key`. There is no error classifier here — see ntfy adapter.
      redirect: 'error',
      // Bound the call — see ntfy adapter.
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Gotify responded ${res.status}`);
  }
}
