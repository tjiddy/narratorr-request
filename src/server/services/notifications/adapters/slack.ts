import type { NotificationChannel, SendContext } from '../types.js';

// Recipe vendored from narratorr's src/core/notifiers/slack.ts (develop), rewired to our
// render() output and throw-on-failure contract.

export interface SlackConfig {
  webhookUrl: string;
}

/** Slack message escaping — `&`/`<`/`>` carry link/mention syntax in user-supplied text. */
function escapeSlack(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export class SlackChannel implements NotificationChannel {
  readonly name = 'slack';
  // The webhook URL is the capability secret — exposed for dispatcher-log redaction.
  readonly secrets: readonly string[];
  constructor(private readonly cfg: SlackConfig) {
    this.secrets = [cfg.webhookUrl];
  }

  async send({ message }: SendContext): Promise<void> {
    // The URL is our own constructed origin — left raw (escaping it would break the link).
    const text =
      `*${escapeSlack(message.title)}*\n${escapeSlack(message.body)}` + (message.url ? `\n${message.url}` : '');

    const res = await fetch(this.cfg.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      // Refuse redirects — see ntfy adapter.
      redirect: 'error',
      // Bound the call — see ntfy adapter.
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Slack responded ${res.status}`);
  }
}
