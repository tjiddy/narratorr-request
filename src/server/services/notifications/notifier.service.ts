import { render } from './render.js';
import { redact } from './redact.js';
import type { NotificationChannel, NotificationPayload, NotifierLogger } from './types.js';

/**
 * Fire-and-forget dispatcher. Fans an event out to every configured channel,
 * isolates failures (one dead channel never blocks the others or the caller), and
 * NEVER throws — callers `void notify(...)` straight from the request path so a
 * flaky notifier can't break request creation.
 */
export class Notifier {
  constructor(
    private readonly channels: NotificationChannel[],
    private readonly baseUrl: string | null,
    private readonly log: NotifierLogger,
  ) {}

  get enabled(): boolean {
    return this.channels.length > 0;
  }

  async notify(payload: NotificationPayload): Promise<void> {
    if (this.channels.length === 0) return;
    const message = render(payload, this.baseUrl);
    await Promise.allSettled(
      this.channels.map(async (ch) => {
        try {
          await ch.send({ payload, message });
          this.log.debug({ channel: ch.name, event: payload.event }, 'notification sent');
        } catch (err: unknown) {
          // redact() before logging: a fetch/network error can embed a capability webhook
          // URL, the Telegram bot-token-in-path, or a value-class token/key — never let it
          // reach the log line raw. The channel exposes its secrets for exact-match scrubbing
          // (the dispatcher has no config); pattern scrubbing covers URL-embedded secrets.
          this.log.warn(
            { channel: ch.name, event: payload.event, err: redact(err, ch.secrets ?? []) },
            'notification failed',
          );
        }
      }),
    );
  }
}
