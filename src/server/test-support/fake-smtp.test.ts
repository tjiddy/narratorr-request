import { Readable } from 'node:stream';
import { describe, it, expect, afterEach } from 'vitest';
import { startFakeSmtp, type FakeSmtp } from './fake-smtp.js';
import { emailRuntimeConfig } from './kindle-send.js';
import { buildKindleTransport, EPUB_MEDIA_TYPE } from '../services/kindle-send.transport.js';

// The SMTP fake's REFUSAL contract, pinned directly — the sibling of `fake-narratorr.test.ts`.
//
// AC2b's whole point is that this fake is NOT permissive: it must reject any credential pair that
// is not the configured one, before a mail transaction can start. Every integration scenario
// connects with the RIGHT credentials, so replacing `onAuth` with an accept-everything stub would
// leave all of them green while the suite silently stopped proving that the application delivers
// the configured username and password at all.
//
// Driven through the REAL `buildKindleTransport`, not a hand-rolled SMTP client: that factory
// attaches `auth` only when BOTH `user` and `pass` are present, so these cases exercise the same
// credential path production uses.

const USER = 'smtp-contract-user';
const PASS = 'smtp-contract-pass';

let fake: FakeSmtp | null = null;

afterEach(async () => {
  await fake?.close();
  fake = null;
});

/** One minimal Kindle-shaped message — the payload is irrelevant to every case here. */
const message = () => ({
  from: 'library@example.com',
  to: 'reader@kindle.com',
  subject: 'Send to Kindle',
  text: 'Your companion ebook is attached.',
  attachments: [
    { filename: 'book.epub', content: Readable.from([Buffer.from('EPUB')]), contentType: EPUB_MEDIA_TYPE },
  ],
});

/** Send one message with the given credentials against the running fake. */
async function sendWith(credentials: { user: string | null; pass: string | null }): Promise<unknown> {
  const transport = buildKindleTransport(
    emailRuntimeConfig({ host: '127.0.0.1', port: fake!.port, secure: false, ...credentials }),
  );
  try {
    return await transport.sendMail(message());
  } finally {
    transport.close();
  }
}

describe('the fake SMTP server refuses any credential pair but the configured one', () => {
  it.each([
    ['a wrong PASSWORD', { user: USER, pass: 'not-the-configured-pass' }],
    ['a wrong USERNAME', { user: 'not-the-configured-user', pass: PASS }],
    ['NO credentials at all', { user: null, pass: null }],
  ])('rejects %s before any mail transaction is admitted', async (_label, credentials) => {
    fake = await startFakeSmtp({ user: USER, pass: PASS });

    await expect(sendWith(credentials)).rejects.toThrow();

    // Nothing got past AUTH: no envelope was accepted and no DATA was retained.
    expect(fake.recipientAttempts).toEqual([]);
    expect(fake.transactions).toEqual([]);
    // The no-credentials case never presents an AUTH command at all (the transport omits `auth`
    // unless BOTH fields are set), so it is refused by `authOptional: false` rather than by
    // `onAuth` — which is why the failure COUNT is asserted per case rather than as a flat `1`.
    expect(fake.authFailures).toBe(credentials.user === null ? 0 : 1);
  }, 30_000);

  it('DISCRIMINATES: the exact configured pair is admitted and retained', async () => {
    // The control. Without it, a fake that refused every connection for an unrelated reason would
    // satisfy the rejections above while proving nothing about the credential comparison.
    fake = await startFakeSmtp({ user: USER, pass: PASS });

    await expect(sendWith({ user: USER, pass: PASS })).resolves.toBeDefined();

    expect(fake.authFailures).toBe(0);
    expect(fake.recipientAttempts).toEqual([{ address: 'reader@kindle.com', accepted: true }]);
    expect(fake.transactions).toHaveLength(1);
    // The authenticated identity is retained on the transaction — the AC2b receipt the happy-path
    // scenario asserts.
    expect(fake.transactions[0]?.username).toBe(USER);
    expect(fake.transactions[0]?.complete).toBe(true);
  }, 30_000);
});
