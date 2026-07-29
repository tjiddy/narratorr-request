import { SMTPServer, type SMTPServerSession } from 'smtp-server';
import type { AddressInfo } from 'node:net';

/**
 * A REAL `smtp-server` fake (issue #150) — the SMTP half of the cross-app integration harness.
 *
 * A `jsonTransport` stub can fabricate `accepted`/`rejected`, but it cannot prove that a DATA which
 * never completes leaves the receiving server with nothing; only a real server can. Two properties
 * this fake is built around:
 *
 *   • It fully DRAINS `onData` and retains each transaction's COMPLETE RFC822 message in order, so
 *     "exactly one message, and it carries every attachment byte" is assertable at the boundary.
 *   • AUTH is MANDATORY and EXACT (AC2b). `buildKindleTransport` attaches `auth` only when BOTH
 *     `user` and `pass` are present (`kindle-send.transport.ts`), so a regression that drops either
 *     one turns the happy path red instead of leaving it green against an open relay. Each retained
 *     transaction carries the authenticated username, so the happy path asserts a POSITIVE receipt.
 */

/** One DATA transaction the fake observed. */
export interface FakeSmtpTransaction {
  /** The complete RFC822 message as it arrived. */
  message: Buffer;
  /** Did DATA reach its terminator AND get a terminal accept? A truncated DATA is `false`. */
  complete: boolean;
  /** The username this transaction authenticated as — the AC2b positive receipt. */
  username: string | null;
  /** The envelope `MAIL FROM`. */
  from: string | null;
  /** The recipients the SERVER accepted at RCPT — what AC13's verification is asserted against. */
  acceptedRecipients: string[];
}

export interface FakeSmtp {
  port: number;
  /** Every DATA transaction, in order. A RCPT rejection never produces one. */
  readonly transactions: readonly FakeSmtpTransaction[];
  /** Every RCPT TO the server saw, and whether it accepted it. */
  readonly recipientAttempts: ReadonlyArray<{ address: string; accepted: boolean }>;
  /** How many AUTH attempts were refused (usernames/passwords are deliberately not retained). */
  readonly authFailures: number;
  /** Reject the recipient at RCPT TO — the "server replied" case. */
  rejectRecipient: boolean;
  /** Reply `550` at the end of DATA. */
  rejectData: boolean;
  close(): Promise<void>;
}

export interface FakeSmtpOptions {
  /** The ONLY username `onAuth` accepts. */
  user: string;
  /** The ONLY password `onAuth` accepts. */
  pass: string;
}

function envelopeOf(session: SMTPServerSession): { from: string | null; acceptedRecipients: string[] } {
  const mailFrom = session.envelope.mailFrom;
  return {
    from: mailFrom === false ? null : mailFrom.address,
    acceptedRecipients: session.envelope.rcptTo.map((r) => r.address),
  };
}

/** Start the fake on `127.0.0.1:0`. */
export async function startFakeSmtp(opts: FakeSmtpOptions): Promise<FakeSmtp> {
  const transactions: FakeSmtpTransaction[] = [];
  const recipientAttempts: Array<{ address: string; accepted: boolean }> = [];
  let authFailures = 0;
  const flags = { rejectRecipient: false, rejectData: false };

  const server = new SMTPServer({
    // MANDATORY, not `authOptional` — an unauthenticated client must never get as far as MAIL FROM.
    authOptional: false,
    // Plain TCP: STARTTLS is hidden so the exchange (and therefore AUTH) is over the raw socket.
    hideSTARTTLS: true,
    onAuth(auth, _session, cb) {
      if (auth.username === opts.user && auth.password === opts.pass) {
        cb(null, { user: auth.username });
        return;
      }
      authFailures += 1;
      cb(new Error('535 authentication failed'));
    },
    onRcptTo(address, _session, cb) {
      const accepted = !flags.rejectRecipient;
      recipientAttempts.push({ address: address.address, accepted });
      cb(accepted ? null : new Error('550 mailbox unavailable'));
    },
    onData(stream, session, cb) {
      const chunks: Buffer[] = [];
      let recorded = false;
      const record = (complete: boolean): void => {
        if (recorded) return;
        recorded = true;
        transactions.push({
          message: Buffer.concat(chunks),
          complete,
          username: typeof session.user === 'string' ? session.user : null,
          ...envelopeOf(session),
        });
      };
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        // Only a DATA that genuinely reached its terminator AND was accepted is `complete` — an
        // aborted attachment must never look like a delivered message.
        record(!flags.rejectData);
        cb(flags.rejectData ? new Error('550 message rejected') : null);
      });
      stream.on('error', () => record(false));
      stream.on('close', () => {
        if (!stream.readableEnded) record(false);
      });
    },
  });
  // Socket-level errors are swallowed so a hardening scenario cannot take the worker down with an
  // unhandled 'error'.
  server.on('error', () => {});

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.server.address() as AddressInfo;

  return {
    port,
    transactions,
    recipientAttempts,
    get authFailures() {
      return authFailures;
    },
    get rejectRecipient() {
      return flags.rejectRecipient;
    },
    set rejectRecipient(v: boolean) {
      flags.rejectRecipient = v;
    },
    get rejectData() {
      return flags.rejectData;
    },
    set rejectData(v: boolean) {
      flags.rejectData = v;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
