import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createNetServer, type AddressInfo, type Socket } from 'node:net';
import { SMTPServer, type SMTPServerSession } from 'smtp-server';
import { describe, it, expect, afterEach } from 'vitest';
import {
  buildKindleSendHarness,
  emailRuntimeConfig,
  type KindleSendHarness,
} from '../test-support/kindle-send.js';
import { KindleSendService } from './kindle-send.service.js';
import { buildKindleTransport } from './kindle-send.transport.js';
import { MAX_KINDLE_SEND_BYTES } from './kindle-send.policy.js';
import { NarratorrStreamClient } from './narratorr-stream-client.js';
import nodemailer from 'nodemailer';
import type { KindleTransportFactory } from './kindle-send.transport.js';

// ---------------------------------------------------------------------------
// REAL sockets on BOTH legs (issue #148).
//
// Upstream is a real `node:http` server, never MSW: MSW honors an abort only while a resolver is
// still pending and re-buffers passthrough bodies, so truncation, oversize and mid-stream abort all
// behave IDENTICALLY for correct and broken code under it (curated learning
// `msw-cannot-test-body-read-abort`). SMTP is a real `smtp-server`, never a `jsonTransport` stub: a
// stub can fabricate `accepted`/`rejected` but cannot prove "DATA never completes, so the receiving
// server discards the partial" — which is the load-bearing property here.
// ---------------------------------------------------------------------------

const BOOK = 'bk_stream';
const RECIPIENT = 'reader@kindle.com';

// ---- The upstream fake ------------------------------------------------------

interface UpstreamServer {
  baseUrl: string;
  close(): Promise<void>;
}

const openHttp: UpstreamServer[] = [];
const openSmtp: FakeSmtp[] = [];
const openRaw: RawSmtp[] = [];

async function startUpstream(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<UpstreamServer> {
  const server = createServer((req, res) => {
    res.on('error', () => {});
    req.on('error', () => {});
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const fake: UpstreamServer = {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  openHttp.push(fake);
  return fake;
}

/** An upstream that writes `total` bytes in `chunkSize` pieces, with a per-chunk delay. */
function bodyServer(opts: {
  total: number;
  chunkSize?: number;
  declaredLength?: number | null;
  /** Destroy the socket after this many bytes — the truncation case. */
  destroyAfter?: number;
  delayMs?: number;
}) {
  return (_req: IncomingMessage, res: ServerResponse): void => {
    const chunkSize = opts.chunkSize ?? opts.total;
    res.writeHead(200, {
      'content-type': 'application/epub+zip',
      ...(opts.declaredLength === null ? {} : { 'content-length': String(opts.declaredLength ?? opts.total) }),
    });
    let written = 0;
    const pump = (): void => {
      if (opts.destroyAfter !== undefined && written >= opts.destroyAfter) {
        res.socket?.destroy();
        return;
      }
      if (written >= opts.total) {
        res.end();
        return;
      }
      const size = Math.min(chunkSize, opts.total - written);
      written += size;
      const more = res.write(Buffer.alloc(size, 0x41));
      const next = () => setTimeout(pump, opts.delayMs ?? 0);
      if (more) next();
      else res.once('drain', next);
    };
    pump();
  };
}

// ---- The SMTP fake ----------------------------------------------------------

interface FakeSmtp {
  port: number;
  /** Every COMPLETED message body, in order. A DATA that never completes appears nowhere here. */
  readonly completed: Buffer[];
  /** Sessions that opened DATA but never completed it. */
  readonly incomplete: number;
  close(): Promise<void>;
}

interface FakeSmtpOpts {
  /** Reject the recipient at RCPT TO — the "server replied" case. */
  rejectRecipient?: boolean;
  /** Reply `550` at the end of DATA. */
  rejectData?: boolean;
  /** Accept every byte of DATA, then never reply. */
  silentAfterData?: boolean;
  /** Reject AUTH — rejects before a single attachment byte is consumed. */
  requireAuth?: boolean;
}

async function startSmtp(opts: FakeSmtpOpts = {}): Promise<FakeSmtp> {
  const completed: Buffer[] = [];
  let incomplete = 0;
  const server = new SMTPServer({
    authOptional: !opts.requireAuth,
    disabledCommands: opts.requireAuth ? [] : ['AUTH'],
    hideSTARTTLS: true,
    onAuth(_auth, _session, cb) {
      cb(new Error('bad credentials'));
    },
    onRcptTo(_address, _session, cb) {
      cb(opts.rejectRecipient ? new Error('550 mailbox unavailable') : null);
    },
    onData(stream, _session: SMTPServerSession, cb) {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        // Only a DATA that genuinely reached its terminator lands in `completed` — an aborted one
        // must be invisible here, which is what "the receiving server discards the partial" means.
        completed.push(Buffer.concat(chunks));
        if (opts.silentAfterData) return; // never call cb — the lost-reply case
        cb(opts.rejectData ? new Error('550 message rejected') : null);
      });
      stream.on('error', () => {
        incomplete += 1;
      });
      stream.on('close', () => {
        if (!stream.readableEnded) incomplete += 1;
      });
    },
  });
  server.on('error', () => {});
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.server.address() as AddressInfo;
  const fake: FakeSmtp = {
    port,
    completed,
    get incomplete() {
      return incomplete;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
  openSmtp.push(fake);
  return fake;
}

/**
 * A RAW SMTP fixture (`node:net`, no `smtp-server`) for the one case a well-behaved library server
 * cannot express: DATA completes, and the peer then emits an UNFINISHED `250-` continuation line
 * just inside every idle interval, never terminating the reply. Nodemailer's parser accumulates
 * partial chunks in `_remainder` until a terminating line, so the socket inactivity timer is reset
 * forever and `sendMail` stays pending — which is exactly the shape a totally silent server does
 * NOT cover, because silence lets the timer fire and would pass an implementation that wrongly
 * believes it has an absolute bound.
 */
interface RawSmtp {
  port: number;
  /** Resolves once DATA has been fully received (the `\r\n.\r\n` terminator arrived). */
  dataComplete: Promise<void>;
  close(): Promise<void>;
}

interface RawSmtpOpts {
  /** Emit an unfinished `250-` continuation every N ms after DATA completes, never terminating. */
  trickleReplyMs?: number;
  /** Destroy the connection once this many DATA bytes have arrived — a mid-DATA disconnect. */
  destroyAfterDataBytes?: number;
}

async function startRawSmtp(opts: RawSmtpOpts): Promise<RawSmtp> {
  let markComplete = (): void => {};
  const dataComplete = new Promise<void>((resolve) => {
    markComplete = resolve;
  });
  const sockets: Socket[] = [];
  const timers: Array<ReturnType<typeof setInterval>> = [];

  const server = createNetServer((socket) => {
    sockets.push(socket);
    socket.on('error', () => {});
    let inData = false;
    let tail = '';
    let dataBytes = 0;
    socket.write('220 fake ESMTP\r\n');
    socket.on('data', (chunk: Buffer) => {
      const text = chunk.toString('latin1');
      if (inData) {
        dataBytes += chunk.length;
        if (opts.destroyAfterDataBytes !== undefined && dataBytes >= opts.destroyAfterDataBytes) {
          socket.destroy();
          return;
        }
        tail = (tail + text).slice(-8);
        if (tail.includes('\r\n.\r\n')) {
          inData = false;
          markComplete();
          if (opts.trickleReplyMs !== undefined) {
            // The pathological reply: a continuation line, forever, never terminated.
            timers.push(setInterval(() => socket.write('250-still thinking\r\n'), opts.trickleReplyMs));
          }
        }
        return;
      }
      for (const line of text.split('\r\n').filter(Boolean)) {
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO' || verb === 'HELO') socket.write('250-fake\r\n250 8BITMIME\r\n');
        else if (verb === 'MAIL' || verb === 'RCPT') socket.write('250 OK\r\n');
        else if (verb === 'DATA') {
          inData = true;
          tail = '';
          socket.write('354 Go ahead\r\n');
        } else if (verb === 'QUIT') socket.end('221 Bye\r\n');
        else socket.write('250 OK\r\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const fake: RawSmtp = {
    port,
    dataComplete,
    close: () =>
      new Promise<void>((resolve) => {
        for (const t of timers) clearInterval(t);
        for (const sock of sockets) sock.destroy();
        server.close(() => resolve());
      }),
  };
  openRaw.push(fake);
  return fake;
}

afterEach(async () => {
  await Promise.all(openHttp.splice(0).map((s) => s.close()));
  await Promise.all(openSmtp.splice(0).map((s) => s.close()));
  await Promise.all(openRaw.splice(0).map((s) => s.close()));
});

/**
 * A real nodemailer transport with a SHORTENED inactivity timeout, for the cases whose whole point
 * is that the timer eventually fires. The production 60s value would make those tests a minute
 * each; the value itself is pinned as a constant by `kindle-send.service.test.ts`, and what these
 * tests exercise is the SEMANTICS the timer produces, not the number.
 */
const fastTransport =
  (socketTimeout: number): KindleTransportFactory =>
  (cfg) => {
    const transport = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      connectionTimeout: 5_000,
      greetingTimeout: 5_000,
      socketTimeout,
    });
    return { sendMail: (m) => transport.sendMail(m), close: () => transport.close() };
  };

// ---- Wiring -----------------------------------------------------------------

/** Point a harness at the real upstream + the real SMTP server. */
async function realHarness(opts: {
  upstream: UpstreamServer;
  smtp: { port: number };
  sizeBytes: number;
  attemptDeadlineMs?: number;
  socketTimeoutMs?: number;
}): Promise<KindleSendHarness> {
  const h = await buildKindleSendHarness(
    opts.attemptDeadlineMs === undefined ? {} : { attemptDeadlineMs: opts.attemptDeadlineMs },
  );
  h.companions.value = { format: 'epub', sizeBytes: opts.sizeBytes };
  h.settings.sender = {
    mailbox: 'library@example.com',
    config: emailRuntimeConfig({ host: '127.0.0.1', port: opts.smtp.port, secure: false }),
  };
  const streamClient = new NarratorrStreamClient({ baseUrl: opts.upstream.baseUrl, apiKey: 'k' });
  // A genuinely-typed service over the REAL clients — only the DB and the metadata seam are fakes.
  const svc = new KindleSendService({
    db: h.db,
    narratorr: streamClient,
    companions: h.companions,
    settings: h.settings,
    transport: opts.socketTimeoutMs === undefined ? buildKindleTransport : fastTransport(opts.socketTimeoutMs),
    logger: h.logger,
    now: h.now,
    ...(opts.attemptDeadlineMs === undefined ? {} : { attemptDeadlineMs: opts.attemptDeadlineMs }),
  });
  return { ...h, svc };
}

describe('the happy path over real sockets', () => {
  it('delivers a COMPLETE message whose attachment byte count matches the advertised size', async () => {
    const upstream = await startUpstream(bodyServer({ total: 2048, chunkSize: 256 }));
    const smtp = await startSmtp();
    const h = await realHarness({ upstream, smtp, sizeBytes: 2048 });

    expect(await h.svc.send(h.user, BOOK)).toEqual({ outcome: 'sent' });
    expect(smtp.completed).toHaveLength(1);
    const message = smtp.completed[0]!.toString('latin1');
    expect(message).toContain(`To: ${RECIPIENT}`);
    // 2048 bytes of 0x41 base64-encode to a long run of `QUFB`; the message must actually carry
    // the payload, not just an empty attachment header.
    expect(message).toContain('QUFBQUFBQUFB');
    expect(message.length).toBeGreaterThan(2048);
    expect((await h.rowsFor(BOOK))[0]).toMatchObject({ status: 'sent', byteCount: 2048, failureCode: null });
  }, 20_000);

  it('puts the SELECTED notifier’s From on the wire — envelope AND header — at a real server', async () => {
    const upstream = await startUpstream(bodyServer({ total: 64 }));
    const smtp = await startSmtp();
    const h = await realHarness({ upstream, smtp, sizeBytes: 64 });
    // A distinguishable sender, resolved from the SELECTED notifier's own config.
    h.settings.sender = {
      mailbox: 'chosen@example.com',
      config: emailRuntimeConfig({
        host: '127.0.0.1',
        port: smtp.port,
        secure: false,
        from: 'Chosen Library <chosen@example.com>',
      }),
    };
    expect(await h.svc.send(h.user, BOOK)).toEqual({ outcome: 'sent' });

    const message = smtp.completed[0]!.toString('latin1');
    // The header From is the notifier's own string, VERBATIM — never a second copy or a rewrite.
    expect(message).toContain('From: Chosen Library <chosen@example.com>');
    expect(message).toContain(`To: ${RECIPIENT}`);
    expect(message).not.toContain('library@example.com');
  }, 20_000);

  it('carries the fixed subject and body only — a hostile title reaches the FILENAME alone', async () => {
    const upstream = await startUpstream(bodyServer({ total: 32 }));
    const smtp = await startSmtp();
    const h = await realHarness({ upstream, smtp, sizeBytes: 32 });

    await h.svc.send(h.user, BOOK, { title: 'PWNED<script>' });
    const message = smtp.completed[0]!.toString('latin1');
    expect(message).toContain('Subject: Send to Kindle');
    expect(message).toContain('Your companion ebook is attached.');
    // No HTML part at all — nothing to inject into.
    expect(message).not.toContain('text/html');
    // The title survives ONLY inside the attachment's filename parameter.
    const [headers, ...rest] = message.split('\r\n\r\n');
    expect(headers).not.toContain('PWNED');
    expect(rest.join('\r\n\r\n')).toContain('PWNEDscript.epub');
  }, 20_000);
});

describe('integrity — enforced as a PRE-COMPLETION abort, never a post-hoc check', () => {
  it('a truncated upstream body is failed / upstream_unavailable and completes NO message', async () => {
    const upstream = await startUpstream(
      bodyServer({ total: 8192, chunkSize: 512, destroyAfter: 1024, delayMs: 1 }),
    );
    const smtp = await startSmtp();
    const h = await realHarness({ upstream, smtp, sizeBytes: 8192 });

    expect(await h.svc.send(h.user, BOOK)).toEqual({ outcome: 'failed' });
    // The receiving server saw no COMPLETED message — DATA never finished.
    expect(smtp.completed).toHaveLength(0);
    const [row] = await h.rowsFor(BOOK);
    expect(row).toMatchObject({ status: 'failed', failureCode: 'upstream_unavailable' });
    expect(await h.rowsFor(BOOK)).not.toContainEqual(expect.objectContaining({ status: 'sent' }));
  }, 20_000);

  it.each([
    ['SHORTER than advertised', 512, 1024],
    ['LONGER than advertised but under the cap', 2048, 1024],
  ])('a body %s is failed / size_mismatch with no completed message', async (_label, total, advertised) => {
    // `content-length` is set to the REAL length so undici does not raise its own framing error —
    // the mismatch under test is between the ADVERTISED metadata and the counted bytes.
    const upstream = await startUpstream(bodyServer({ total, chunkSize: 128 }));
    const smtp = await startSmtp();
    const h = await realHarness({ upstream, smtp, sizeBytes: advertised });

    expect(await h.svc.send(h.user, BOOK)).toEqual({ outcome: 'failed' });
    expect(smtp.completed).toHaveLength(0);
    expect((await h.rowsFor(BOOK))[0]).toMatchObject({ status: 'failed', failureCode: 'size_mismatch', byteCount: total });
  }, 20_000);

  it('a body that keeps producing past the cap aborts at limit + 1 → failed / oversize', async () => {
    // The advertised size is admissible; the PRODUCER lies. The cap is enforced on bytes actually
    // seen, so a lying annotation cannot smuggle a larger payload.
    const upstream = await startUpstream(
      bodyServer({ total: MAX_KINDLE_SEND_BYTES + 1_048_576, chunkSize: 1_048_576, declaredLength: null }),
    );
    const smtp = await startSmtp();
    const h = await realHarness({ upstream, smtp, sizeBytes: 1024 });

    expect(await h.svc.send(h.user, BOOK)).toEqual({ outcome: 'failed' });
    expect(smtp.completed).toHaveLength(0);
    const [row] = await h.rowsFor(BOOK);
    expect(row?.failureCode).toBe('oversize');
    // Counted bytes never exceed MAX + 1 — the counter is pinned there rather than absorbing a
    // whole oversized chunk.
    expect(row?.byteCount).toBe(MAX_KINDLE_SEND_BYTES + 1);
  }, 60_000);

  it('a genuinely mismatched HTTP FRAME is an upstream failure, not a silent success', async () => {
    // undici ENFORCES `Content-Length`: a short body raises a premature-close error rather than
    // reaching a clean EOF. Requiring `sent` here would force the implementation to swallow a real
    // truncation to make the suite green.
    const upstream = await startUpstream(bodyServer({ total: 400, declaredLength: 1000 }));
    const smtp = await startSmtp();
    const h = await realHarness({ upstream, smtp, sizeBytes: 400 });

    expect(await h.svc.send(h.user, BOOK)).toEqual({ outcome: 'failed' });
    expect((await h.rowsFor(BOOK))[0]?.failureCode).toBe('upstream_unavailable');
    expect(smtp.completed).toHaveLength(0);
  }, 20_000);

  it('an ABSENT content-length (chunked) still sends — the header is informational here', async () => {
    const upstream = await startUpstream(bodyServer({ total: 300, chunkSize: 100, declaredLength: null }));
    const smtp = await startSmtp();
    const h = await realHarness({ upstream, smtp, sizeBytes: 300 });
    expect(await h.svc.send(h.user, BOOK)).toEqual({ outcome: 'sent' });
  }, 20_000);
});

describe('Content-Length is never the integrity source (split by seam)', () => {
  it.each([
    ['a WRONG advertised content-length', 999_999],
    ['a NULL content-length', null],
  ])('%s still sends when the COUNTED bytes match sizeBytes', async (_label, contentLength) => {
    // Against a direct stream fake (no socket), so "wrong length, complete body" is expressible at
    // all — a real socket cannot produce it, because undici enforces the frame.
    const h = await buildKindleSendHarness();
    h.companions.value = { format: 'epub', sizeBytes: 16 };
    h.stream.bytes = new Uint8Array(16);
    h.stream.contentLength = contentLength;
    expect(await h.svc.send(h.user, BOOK)).toEqual({ outcome: 'sent' });
  });

  it('a content-length equal to the counted bytes does NOT rescue a differing sizeBytes', async () => {
    // The inverse: if integrity read `NarratorrEbookStream.contentLength` instead of the
    // advertised metadata, this would wrongly pass.
    const h = await buildKindleSendHarness();
    h.companions.value = { format: 'epub', sizeBytes: 99 };
    h.stream.bytes = new Uint8Array(16);
    h.stream.contentLength = 16;
    expect(await h.svc.send(h.user, BOOK)).toEqual({ outcome: 'failed' });
    expect((await h.rowsFor(BOOK))[0]?.failureCode).toBe('size_mismatch');
  });
});

describe('bounded memory — the attachment is streamed, never buffered whole', () => {
  it('does not run upstream production to completion ahead of downstream demand', async () => {
    // A large body with a deliberately slow consumer. If the implementation buffered (or used
    // `Readable.from(wholeBuffer)`), production would race to the end regardless of demand — which
    // an "is it a stream instance" assertion would happily accept.
    const TOTAL = 8 * 1024 * 1024;
    let produced = 0;
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/epub+zip', 'content-length': String(TOTAL) });
      const pump = (): void => {
        if (produced >= TOTAL) {
          res.end();
          return;
        }
        const size = Math.min(64 * 1024, TOTAL - produced);
        produced += size;
        if (res.write(Buffer.alloc(size, 0x41))) setImmediate(pump);
        else res.once('drain', pump);
      };
      pump();
    });
    const smtp = await startSmtp();
    const h = await realHarness({ upstream, smtp, sizeBytes: TOTAL });

    const sending = h.svc.send(h.user, BOOK);
    // Sample production a few ticks in: with genuine end-to-end backpressure, only a bounded
    // amount can be in flight this early.
    await new Promise((r) => setTimeout(r, 25));
    const early = produced;
    expect(early).toBeLessThan(TOTAL);

    expect(await sending).toEqual({ outcome: 'sent' });
    expect(produced).toBe(TOTAL);
  }, 60_000);
});

describe('the submission boundary — the transform’s `end`, deliberately over-approximating', () => {
  it('a disconnect BEFORE the transform reaches end is failed', async () => {
    const upstream = await startUpstream(bodyServer({ total: 512 * 1024, chunkSize: 8192, delayMs: 2 }));
    // Driven from a RAW server so the socket is genuinely ours to destroy mid-DATA.
    const raw = await startRawSmtp({ destroyAfterDataBytes: 16 * 1024 });
    const h = await realHarness({ upstream, smtp: raw, sizeBytes: 512 * 1024, socketTimeoutMs: 5_000 });

    expect(await h.svc.send(h.user, BOOK)).toEqual({ outcome: 'failed' });
    // Stage decides: the transform had not reached `end`, so this is `failed`, never
    // `indeterminate` — and the code is the catch-all, since no named cause of ours induced it.
    expect((await h.rowsFor(BOOK))[0]).toMatchObject({ status: 'failed', failureCode: 'smtp_error' });
  }, 30_000);

  it('a COMPLETE DATA followed by NO reply is indeterminate — never a clean `failed`', async () => {
    const upstream = await startUpstream(bodyServer({ total: 1024 }));
    const smtp = await startSmtp({ silentAfterData: true });
    // The socket INACTIVITY timer is what settles this; the send budget is deliberately wide so
    // the deadline is not what ends it.
    const h = await realHarness({ upstream, smtp, sizeBytes: 1024, attemptDeadlineMs: 60_000, socketTimeoutMs: 800 });

    expect(await h.svc.send(h.user, BOOK)).toEqual({ outcome: 'indeterminate' });
    const [row] = await h.rowsFor(BOOK);
    // `indeterminate` carries no failure code: we genuinely do not know, and it is never retried.
    expect(row).toMatchObject({ status: 'indeterminate', failureCode: null });
  }, 30_000);

  it('a server replying 550 at DATA is failed / smtp_rejected — question 2 wins regardless of stage', async () => {
    const upstream = await startUpstream(bodyServer({ total: 1024 }));
    const smtp = await startSmtp({ rejectData: true });
    const h = await realHarness({ upstream, smtp, sizeBytes: 1024 });

    expect(await h.svc.send(h.user, BOOK)).toEqual({ outcome: 'failed' });
    expect((await h.rowsFor(BOOK))[0]?.failureCode).toBe('smtp_rejected');
  }, 30_000);

  it('a recipient rejected at RCPT is failed / smtp_rejected', async () => {
    const upstream = await startUpstream(bodyServer({ total: 1024 }));
    const smtp = await startSmtp({ rejectRecipient: true });
    const h = await realHarness({ upstream, smtp, sizeBytes: 1024 });

    expect(await h.svc.send(h.user, BOOK)).toEqual({ outcome: 'failed' });
    expect((await h.rowsFor(BOOK))[0]?.failureCode).toBe('smtp_rejected');
    expect(smtp.completed).toHaveLength(0);
  }, 30_000);

  it('an AUTH failure rejects before ANY attachment byte → failed / smtp_error (the catch-all)', async () => {
    const upstream = await startUpstream(bodyServer({ total: 1024 }));
    const smtp = await startSmtp({ requireAuth: true });
    const h = await realHarness({ upstream, smtp, sizeBytes: 1024 });

    expect(await h.svc.send(h.user, BOOK)).toEqual({ outcome: 'failed' });
    const [row] = await h.rowsFor(BOOK);
    // `EAUTH` lands on `failed` through the SAME stage rule as a dropped socket — there is
    // deliberately no "connection-class error" concept to special-case it.
    expect(['smtp_error', 'smtp_rejected']).toContain(row?.failureCode);
  }, 30_000);
});

describe('accepted / rejected verification', () => {
  it('accepts a CASE-DIFFERING echo of the stored address', async () => {
    const h = await buildKindleSendHarness();
    h.transports.reply = () => Promise.resolve({ accepted: ['Reader@KINDLE.com'], rejected: [] });
    expect(await h.svc.send(h.user, BOOK)).toEqual({ outcome: 'sent' });
  });

  it.each([
    ['the address in NEITHER list', { accepted: ['someone@else.com'], rejected: [] }],
    ['an EMPTY accepted list', { accepted: [], rejected: [] }],
    ['the address in rejected too', { accepted: [RECIPIENT], rejected: [RECIPIENT] }],
  ])('a resolved sendMail with %s is failed / smtp_rejected', async (_label, info) => {
    const h = await buildKindleSendHarness();
    h.transports.reply = () => Promise.resolve(info);
    expect(await h.svc.send(h.user, BOOK)).toEqual({ outcome: 'failed' });
    expect((await h.rowsFor(BOOK))[0]?.failureCode).toBe('smtp_rejected');
  });
});

describe('the attempt deadline bounds the SEND', () => {
  it('a slow-trickle body aborts at the deadline: no completed message, failed / attempt_timeout', async () => {
    // A `socketTimeout`-only implementation runs forever here: the body dribbles just inside every
    // idle interval, which resets an inactivity timer indefinitely.
    const upstream = await startUpstream(bodyServer({ total: 64 * 1024, chunkSize: 64, delayMs: 25 }));
    const smtp = await startSmtp();
    const h = await realHarness({ upstream, smtp, sizeBytes: 64 * 1024, attemptDeadlineMs: 300 });

    const started = Date.now();
    expect(await h.svc.send(h.user, BOOK)).toEqual({ outcome: 'failed' });
    const elapsed = Date.now() - started;

    expect((await h.rowsFor(BOOK))[0]).toMatchObject({ status: 'failed', failureCode: 'attempt_timeout' });
    expect(smtp.completed).toHaveLength(0);
    // The per-user section is released promptly HERE — the transform had not reached `end`, so
    // destroying it genuinely aborts the transaction. (That is not a general duration bound; the
    // post-`end` window has none.)
    expect(elapsed).toBeLessThan(10_000);
  }, 30_000);

  it('aborts the upstream signal, so the fetch is cancelled rather than left draining', async () => {
    const upstream = await startUpstream(bodyServer({ total: 64 * 1024, chunkSize: 64, delayMs: 25 }));
    const smtp = await startSmtp();
    const h = await buildKindleSendHarness({ attemptDeadlineMs: 200 });
    h.companions.value = { format: 'epub', sizeBytes: 64 * 1024 };
    h.stream.bytes = new Uint8Array(64 * 1024);
    h.stream.chunks = 1024;
    let aborted = false;
    h.stream.beforeChunk = async () => {
      h.stream.signals.at(-1)?.addEventListener('abort', () => {
        aborted = true;
      });
      await new Promise((r) => setTimeout(r, 5));
    };
    expect((await h.svc.send(h.user, BOOK)).outcome).toBe('failed');
    expect(aborted).toBe(true);
    // The timer is armed no earlier than the open: a refusal decided before it never arms one.
    expect(h.stream.signals).toHaveLength(1);
    await Promise.all([upstream.close(), smtp.close()]);
  }, 30_000);

  it('never arms a deadline for an attempt that opens no upstream connection', async () => {
    const h = await buildKindleSendHarness({ attemptDeadlineMs: 5 });
    h.companions.value = null;
    expect(await h.svc.send(h.user, BOOK)).toEqual({ outcome: 'unavailable' });
    expect(h.stream.signals).toEqual([]);
  });
});

describe('the section outlives the deadline when SMTP is uncancellable', () => {
  it('a never-terminated 250- continuation keeps sendMail pending and the section HELD', async () => {
    const upstream = await startUpstream(bodyServer({ total: 1024 }));
    // The trickle interval is well inside the shortened inactivity window, so the timer is reset
    // forever — a silent server would instead let it fire. That difference is exactly what
    // distinguishes an inactivity timer from an absolute one.
    const raw = await startRawSmtp({ trickleReplyMs: 100 });
    const h = await realHarness({
      upstream,
      smtp: raw,
      sizeBytes: 1024,
      attemptDeadlineMs: 150,
      socketTimeoutMs: 1_000,
    });

    let settled = false;
    const wedged = h.svc.send(h.user, BOOK).then((r) => {
      settled = true;
      return r;
    });
    await raw.dataComplete;
    // Well past the deadline: it fired and SELECTED an outcome, but `transport.close()` is cleanup,
    // not cancellation — a non-pooled SMTPTransport builds its connection as a local and does not
    // listen for it — so the attempt cannot be terminated and the section must keep waiting.
    await new Promise((r) => setTimeout(r, 600));
    expect(settled).toBe(false);
    expect((await h.rowsFor(BOOK))[0]?.status).toBe('started');

    // Max-concurrency-1 still holds: a DIFFERENT book for the SAME user cannot even reserve, let
    // alone start SMTP, while the first transaction is still on the wire.
    let queuedSettled = false;
    const queued = h.svc.send(h.user, 'bk_queued').then((r) => {
      queuedSettled = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(queuedSettled).toBe(false);
    expect(await h.rowsFor('bk_queued')).toEqual([]);

    // The section duration is deliberately NOT asserted to be bounded — the spec states none
    // exists. Tearing the peer down is what releases it here.
    await raw.close();
    const result = await wedged;
    // The deadline fired AFTER the transform reached `end`, so the honest row is `indeterminate`
    // (every byte was handed over; only the reply is missing) — and `sendMail` settling late
    // cannot change the already-selected outcome.
    expect(result).toEqual({ outcome: 'indeterminate' });
    expect((await h.rowsFor(BOOK))[0]).toMatchObject({ status: 'indeterminate', failureCode: null });
    await queued;
  }, 30_000);
});
