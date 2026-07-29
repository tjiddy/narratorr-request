import type { Readable } from 'node:stream';
import type { EmailRuntimeConfig } from '../services/notifications/index.js';
import type {
  KindleMailMessage,
  KindleSendInfo,
  KindleTransportFactory,
} from '../services/kindle-send.transport.js';

/**
 * Read an attachment stream to completion, PROPAGATING its error.
 *
 * Draining is what makes this fake behave like a transport rather than a stub: a real SMTP
 * transaction consumes every attachment byte, which is what lets the counting transform reach
 * `flush()` (and therefore its integrity check) and reach `end` (the stage discriminator the
 * rejection taxonomy asks about). A fake that never read the stream would report every send as a
 * mid-stream abort.
 */
async function drain(stream: Readable | undefined): Promise<void> {
  if (!stream) return;
  await new Promise<void>((resolve, reject) => {
    stream.on('data', () => {});
    stream.on('end', () => resolve());
    stream.on('error', (err: Error) => reject(err));
  });
}

/**
 * A recording Kindle transport factory for tests that do NOT need a real socket (route surface,
 * admission races, redaction). Streaming truncation and DATA-abort semantics genuinely require a
 * real SMTP server — those live in the stream test file against `smtp-server`.
 */
export class FakeKindleTransports {
  /** Every message handed to `sendMail`, in order. */
  readonly messages: KindleMailMessage[] = [];
  /** Every config the factory was asked to build a transport for, in order. */
  readonly configs: EmailRuntimeConfig[] = [];
  /** Counted `close()` calls — the teardown receipt. */
  closed = 0;
  /** How many bytes each drained attachment carried, in order. */
  readonly drainedBytes: number[] = [];
  /**
   * What a drained send resolves (or rejects) with. Defaults to accepting the recipient. Override
   * per test to drive the AC39 predicate and the AC40 rejection taxonomy.
   */
  reply: (message: KindleMailMessage) => Promise<KindleSendInfo> = (message) =>
    Promise.resolve({ accepted: [message.to], rejected: [] });

  readonly factory: KindleTransportFactory = (config) => {
    this.configs.push(config);
    return {
      sendMail: async (message) => {
        this.messages.push(message);
        let bytes = 0;
        const content = message.attachments[0]?.content;
        content?.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
        });
        try {
          await drain(content);
        } finally {
          this.drainedBytes.push(bytes);
        }
        return this.reply(message);
      },
      close: () => {
        this.closed += 1;
      },
    };
  };
}

/** A usable email-notifier runtime config — the shape the sender resolver hands the send path. */
export function emailRuntimeConfig(over: Partial<EmailRuntimeConfig> = {}): EmailRuntimeConfig {
  return {
    host: 'smtp.example.com',
    port: 587,
    secure: false,
    user: null,
    pass: null,
    from: 'library@example.com',
    to: 'admin@example.com',
    ...over,
  };
}
