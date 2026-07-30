import type { NotificationChannel, SendContext } from '../types.js';

// Recipe vendored from narratorr's src/core/notifiers/telegram.ts (develop), rewired to our
// render() output and throw-on-failure contract. The bot token rides in the request URL
// path — a network error embeds it, so the dispatcher/Test sinks redact() before logging.

export interface TelegramConfig {
  botToken: string;
  chatId: string;
}

/** HTML-escape user-supplied text for Telegram's `parse_mode: 'HTML'`. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export class TelegramChannel implements NotificationChannel {
  readonly name = 'telegram';
  // The bot token is the secret (rides in the request URL path) — exposed for dispatcher-log redaction.
  readonly secrets: readonly string[];
  constructor(private readonly cfg: TelegramConfig) {
    this.secrets = [cfg.botToken];
  }

  async send({ message }: SendContext): Promise<void> {
    // The URL is our own constructed origin (no HTML metacharacters) — left raw.
    const text =
      `<b>${escapeHtml(message.title)}</b>\n${escapeHtml(message.body)}` + (message.url ? `\n${message.url}` : '');

    const res = await fetch(`https://api.telegram.org/bot${this.cfg.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: this.cfg.chatId, text, parse_mode: 'HTML' }),
      // Refuse redirects — see ntfy adapter.
      redirect: 'error',
      // Bound the call — see ntfy adapter.
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Telegram responded ${res.status}`);
  }
}
