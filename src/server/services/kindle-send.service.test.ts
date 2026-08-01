import { describe, it, expect } from 'vitest';
import { buildKindleSendHarness, emailRuntimeConfig } from '../test-support/kindle-send.js';
import { drizzleConstraintError } from '../test-support/db.js';
import {
  KINDLE_SEND_ATTEMPT_DEADLINE_MS,
  KINDLE_SEND_DAILY_WINDOW_MS,
  KINDLE_SEND_LEASE_MS,
  KINDLE_SEND_REPLAY_WINDOW_MS,
  KINDLE_SEND_START_WINDOW_MS,
  MAX_KINDLE_SEND_BYTES,
  admitSizeBytes,
  isActiveKindleSendCollision,
  isInsideWindow,
  sendBudgetMs,
} from './kindle-send.policy.js';
import {
  CountingEpubStream,
  KINDLE_SMTP_CONNECTION_TIMEOUT_MS,
  KINDLE_SMTP_GREETING_TIMEOUT_MS,
  KINDLE_SMTP_SOCKET_INACTIVITY_TIMEOUT_MS,
  KINDLE_SEND_SUBJECT,
  KINDLE_SEND_TEXT,
  classifySendRejection,
  deadlineOutcome,
  hasServerReply,
  kindleTransportOptions,
  sendMailAccepted,
} from './kindle-send.transport.js';
import { EBOOK_SEND_OUTCOMES, KINDLE_SEND_FAILURE_CODES, ebookSendResultSchema } from '../../shared/schemas/ebooks.js';

// `KindleSendService` preconditions + the pure policy/classification units (issue #148). The
// race-safe admission machinery, the real-socket streaming semantics and the redaction sweep each
// have their own file; this one owns "what a refusal is" and "which row a settlement picks".

const BOOK = 'bk_abc123';

describe('preconditions — each refusal opens ZERO EPUB streams and writes NO row', () => {
  it('no_kindle_address when the caller has no stored address', async () => {
    const h = await buildKindleSendHarness({ kindleEmail: null });
    expect(await h.svc.send(h.user, BOOK)).toEqual({ outcome: 'no_kindle_address' });
    expect(h.stream.opened).toEqual([]);
    expect(await h.rows()).toEqual([]);
    // The sender/companion rungs below it are never even consulted.
    expect(h.settings.calls).toBe(0);
    expect(h.companions.calls).toEqual([]);
  });

  it.each(['notifier-missing', 'not-email', 'config-unusable', 'from-unparseable', 'sender-changed'] as const)(
    'no_sender for the %s failure — NOT a 403, because the feature is on and the config is the problem',
    async (failure) => {
      const h = await buildKindleSendHarness();
      h.settings.sender = { failure };
      expect(await h.svc.send(h.user, BOOK)).toEqual({ outcome: 'no_sender' });
      expect(h.stream.opened).toEqual([]);
      expect(await h.rows()).toEqual([]);
    },
  );

  it('no_sender for a NULL selection (nothing chosen at all)', async () => {
    const h = await buildKindleSendHarness();
    h.settings.sender = null;
    expect(await h.svc.send(h.user, BOOK)).toEqual({ outcome: 'no_sender' });
    expect(h.stream.opened).toEqual([]);
  });

  it('unavailable when the companion accessor reports none — including a well-formed unknown id', async () => {
    const h = await buildKindleSendHarness();
    h.companions.value = null;
    expect(await h.svc.send(h.user, 'bk_never_heard_of')).toEqual({ outcome: 'unavailable' });
    expect(h.stream.opened).toEqual([]);
    expect(await h.rows()).toEqual([]);
    // The METADATA seam MAY be called — resolving `sizeBytes` is impossible without it. Only the
    // STREAM seam must stay untouched.
    expect(h.companions.calls).toEqual(['bk_never_heard_of']);
  });

  it.each([
    ['0 (admitted — never falsy-coerced into "missing")', 0, 'sent'],
    ['exactly MAX (admitted)', MAX_KINDLE_SEND_BYTES, 'sent'],
    ['MAX + 1', MAX_KINDLE_SEND_BYTES + 1, 'too_large'],
    ['NaN', Number.NaN, 'unavailable'],
    ['Infinity', Number.POSITIVE_INFINITY, 'unavailable'],
    ['-1', -1, 'unavailable'],
    ['0.5', 0.5, 'unavailable'],
  ] as const)('sizeBytes %s → %s', async (_label, sizeBytes, expected) => {
    const h = await buildKindleSendHarness();
    h.companions.value = { format: 'epub', sizeBytes };
    // Only the admitted cases would fetch bytes; keep the fake body honest for those.
    h.stream.bytes = new Uint8Array(Number.isSafeInteger(sizeBytes) && sizeBytes >= 0 && sizeBytes <= 8 ? sizeBytes : 0);

    if (expected === 'sent') {
      // MAX is admitted at PREFLIGHT — the stream is opened. Drive only the small cases end to end.
      if (sizeBytes === MAX_KINDLE_SEND_BYTES) {
        h.stream.bytes = new Uint8Array(0);
        // A mismatching body is `failed`, not `too_large`: what matters is that preflight admitted.
        expect((await h.svc.send(h.user, BOOK)).outcome).toBe('failed');
        expect(h.stream.opened).toEqual([BOOK]);
        return;
      }
      expect(await h.svc.send(h.user, BOOK)).toEqual({ outcome: 'sent' });
      expect(h.stream.opened).toEqual([BOOK]);
      return;
    }
    expect(await h.svc.send(h.user, BOOK)).toEqual({ outcome: expected });
    // Every refusal is decided from the ADVERTISED value with zero EPUB bytes fetched.
    expect(h.stream.opened).toEqual([]);
    expect(await h.rows()).toEqual([]);
  });

  it('runs the ladder in order: address → sender → companion → size', async () => {
    const h = await buildKindleSendHarness({ kindleEmail: null });
    h.settings.sender = { failure: 'notifier-missing' };
    h.companions.value = null;
    // Every rung would refuse; the FIRST one wins, and the later seams are never touched.
    expect(await h.svc.send(h.user, BOOK)).toEqual({ outcome: 'no_kindle_address' });
    expect(h.settings.calls).toBe(0);
  });

  it('every outcome the service can return parses against the wire schema', async () => {
    const h = await buildKindleSendHarness({ kindleEmail: null });
    expect(ebookSendResultSchema.safeParse(await h.svc.send(h.user, BOOK)).success).toBe(true);
  });
});

describe('frozen contracts', () => {
  it('freezes the outcome union and the failure-code list', () => {
    expect(EBOOK_SEND_OUTCOMES).toEqual([
      'sent',
      'no_kindle_address',
      'no_sender',
      'unavailable',
      'too_large',
      'rate_limited',
      'quota_exhausted',
      'failed',
      'indeterminate',
    ]);
    expect(KINDLE_SEND_FAILURE_CODES).toEqual([
      'upstream_unavailable',
      'oversize',
      'size_mismatch',
      'smtp_rejected',
      'smtp_error',
      'attempt_timeout',
      'lease_expired',
    ]);
  });

  it('freezes the policy constants, and the SEND-BUDGET relation the lease clamp rests on', () => {
    expect(MAX_KINDLE_SEND_BYTES).toBe(25 * 1024 * 1024);
    expect(KINDLE_SEND_START_WINDOW_MS).toBe(60_000);
    expect(KINDLE_SEND_REPLAY_WINDOW_MS).toBe(60_000);
    expect(KINDLE_SEND_LEASE_MS).toBe(600_000);
    expect(KINDLE_SEND_DAILY_WINDOW_MS).toBe(86_400_000);
    expect(KINDLE_SEND_ATTEMPT_DEADLINE_MS).toBe(300_000);
    // The relation is about the SEND BUDGET only: a reservation is never FED past its own lease.
    // There is deliberately NO assertion of a finite worst-case critical-section duration — the
    // post-DATA SMTP window and every database call are uncancellable, so none exists.
    expect(KINDLE_SEND_ATTEMPT_DEADLINE_MS).toBeLessThan(KINDLE_SEND_LEASE_MS);
  });

  it('uses the dedicated SMTP profile, not the requester-email 10s/10s/20s one', () => {
    const opts = kindleTransportOptions(emailRuntimeConfig({ user: 'u', pass: 'p' }));
    expect(opts).toMatchObject({
      connectionTimeout: KINDLE_SMTP_CONNECTION_TIMEOUT_MS,
      greetingTimeout: KINDLE_SMTP_GREETING_TIMEOUT_MS,
      socketTimeout: KINDLE_SMTP_SOCKET_INACTIVITY_TIMEOUT_MS,
      auth: { user: 'u', pass: 'p' },
    });
    expect([opts['connectionTimeout'], opts['greetingTimeout'], opts['socketTimeout']]).not.toEqual([
      10_000, 10_000, 20_000,
    ]);
    // A passwordless / open-relay source omits the auth block entirely.
    expect(kindleTransportOptions(emailRuntimeConfig())).not.toHaveProperty('auth');
  });
});

describe('one window convention — a record aged EXACTLY the window is INSIDE it', () => {
  it.each([
    ['per-minute starts', KINDLE_SEND_START_WINDOW_MS],
    ['replay', KINDLE_SEND_REPLAY_WINDOW_MS],
    ['daily quota', KINDLE_SEND_DAILY_WINDOW_MS],
    ['reservation lease', KINDLE_SEND_LEASE_MS],
  ])('%s: exactly at the cutoff is inside, one ms beyond is outside', (_label, windowMs) => {
    const now = 10_000_000;
    expect(isInsideWindow(now - windowMs, now, windowMs)).toBe(true);
    expect(isInsideWindow(now - windowMs - 1, now, windowMs)).toBe(false);
  });
});

describe('admitSizeBytes — the policy layer, with the vendored schema left lenient', () => {
  it.each([
    [0, 'ok'],
    [1, 'ok'],
    [MAX_KINDLE_SEND_BYTES, 'ok'],
    [MAX_KINDLE_SEND_BYTES + 1, 'too_large'],
    [-1, 'unavailable'],
    [0.5, 'unavailable'],
    [Number.NaN, 'unavailable'],
    [Number.POSITIVE_INFINITY, 'unavailable'],
    [Number.MAX_SAFE_INTEGER + 2, 'unavailable'],
  ])('%p → %s', (size, expected) => {
    expect(admitSizeBytes(size)).toBe(expected);
  });
});

describe('sendBudgetMs — clamped to the reservation’s remaining lease', () => {
  it('uses the attempt deadline when the whole lease is still ahead', () => {
    expect(sendBudgetMs({ nowMs: 1000, reservationStartedAtMs: 1000 })).toBe(KINDLE_SEND_ATTEMPT_DEADLINE_MS);
  });

  it('clamps to the remaining lease for a reservation observed LATE', () => {
    // Durable at T0, observed at T0 + (LEASE - 30s): a full five-minute send would run past the
    // lease and onto a row a sweep may converge.
    const startedAt = 1_000_000;
    const nowMs = startedAt + KINDLE_SEND_LEASE_MS - 30_000;
    expect(sendBudgetMs({ nowMs, reservationStartedAtMs: startedAt })).toBe(30_000);
  });

  it('is <= 0 once the observed reservation is already at or past its lease', () => {
    const startedAt = 1_000_000;
    expect(sendBudgetMs({ nowMs: startedAt + KINDLE_SEND_LEASE_MS, reservationStartedAtMs: startedAt })).toBe(0);
    expect(
      sendBudgetMs({ nowMs: startedAt + KINDLE_SEND_LEASE_MS + 5000, reservationStartedAtMs: startedAt }),
    ).toBeLessThan(0);
  });

  it('honours the injected deadline override without losing the clamp', () => {
    const startedAt = 1_000_000;
    expect(sendBudgetMs({ nowMs: startedAt, reservationStartedAtMs: startedAt, attemptDeadlineMs: 50 })).toBe(50);
    expect(
      sendBudgetMs({
        nowMs: startedAt + KINDLE_SEND_LEASE_MS - 10,
        reservationStartedAtMs: startedAt,
        attemptDeadlineMs: 50,
      }),
    ).toBe(10);
  });
});

describe('isActiveKindleSendCollision — target-specific, and gated on the structural unique code', () => {
  const COLLISION_MESSAGE = 'UNIQUE constraint failed: kindle_sends.user_id, kindle_sends.book_id';
  /** The real drizzle/libSQL 3-level shape for a kindle_sends breach. */
  const kindleError = (rawCode: number, code: string, driverMessage: string) =>
    drizzleConstraintError({ rawCode, code, driverMessage, table: 'kindle_sends' });

  it('matches the active-reservation unique index', () => {
    expect(isActiveKindleSendCollision(kindleError(2067, 'SQLITE_CONSTRAINT_UNIQUE', COLLISION_MESSAGE))).toBe(true);
  });

  it.each([
    ['a FOREIGN KEY breach', 787, 'SQLITE_CONSTRAINT_FOREIGNKEY', 'FOREIGN KEY constraint failed'],
    ['a CHECK breach', 275, 'SQLITE_CONSTRAINT_CHECK', 'CHECK constraint failed: kindle_sends_status_finalized'],
    ['a NOT NULL breach', 1299, 'SQLITE_CONSTRAINT_NOTNULL', 'NOT NULL constraint failed: kindle_sends.status'],
    // Carries the UNIQUE code too, so this row proves the REGEX rejects it — not the new gate.
    ['another table’s unique index', 2067, 'SQLITE_CONSTRAINT_UNIQUE', 'UNIQUE constraint failed: requests.public_id'],
  ] as const)('does NOT match %s — those are genuine corruption, not "slow down"', (_label, rawCode, code, message) => {
    expect(isActiveKindleSendCollision(kindleError(rawCode, code, message))).toBe(false);
  });

  it('does NOT match the collision MESSAGE when no link of the chain carries the unique code', () => {
    // The structural gate is unconditional: it is not a fallback that yields to the regex when
    // `rawCode` happens to be absent. Message text alone — forgeable through drizzle's echoed
    // `params:` line — never classifies as a collision.
    const messageOnly = new Error('Failed query: insert into "kindle_sends" ...', {
      cause: new Error(`SQLITE_CONSTRAINT: ${COLLISION_MESSAGE}`),
    });
    expect(isActiveKindleSendCollision(messageOnly)).toBe(false);
  });

  it('short-circuits a RangeError and tolerates a non-Error throw', () => {
    // The cause satisfies BOTH other conjuncts (unique code AND the target index name), so the
    // guard is the only thing making this false — deleting it turns this red.
    const range = new RangeError('out of range', {
      cause: kindleError(2067, 'SQLITE_CONSTRAINT_UNIQUE', COLLISION_MESSAGE),
    });
    expect(isActiveKindleSendCollision(range)).toBe(false);
    expect(isActiveKindleSendCollision('nope')).toBe(false);
    expect(isActiveKindleSendCollision(undefined)).toBe(false);
  });
});

describe('sendMailAccepted — the resolved-sendMail success predicate', () => {
  const TO = 'reader@kindle.com';

  it('accepts a case-differing echo of the address', () => {
    expect(sendMailAccepted({ accepted: ['Reader@Kindle.COM'], rejected: [] }, TO)).toBe(true);
    expect(sendMailAccepted({ accepted: [{ address: 'READER@kindle.com' }], rejected: [] }, TO)).toBe(true);
  });

  it.each([
    ['an empty accepted list', { accepted: [], rejected: [] }],
    ['the address in rejected too', { accepted: [TO], rejected: [TO] }],
    ['the address in neither list', { accepted: ['someone@else.com'], rejected: [] }],
    ['no lists at all', {}],
  ])('rejects %s', (_label, info) => {
    expect(sendMailAccepted(info, TO)).toBe(false);
  });
});

describe('rejection classification — three ordered questions, no error-code taxonomy', () => {
  const NO_STAGE = { reachedEnd: false, abortReason: null, upstreamErrored: false } as const;

  it('hasServerReply keys ONLY on a numeric responseCode', () => {
    expect(hasServerReply({ responseCode: 550 })).toBe(true);
    expect(hasServerReply({ responseCode: '550' })).toBe(false);
    expect(hasServerReply({ code: 'ECONNECTION', command: 'CONN' })).toBe(false);
    expect(hasServerReply(null)).toBe(false);
  });

  it('row 3: a server REPLY is definitive regardless of stage', () => {
    for (const reachedEnd of [false, true]) {
      expect(classifySendRejection({ responseCode: 550 }, { ...NO_STAGE, reachedEnd })).toEqual({
        status: 'failed',
        failureCode: 'smtp_rejected',
      });
    }
  });

  it('rows 4 and 5: our own aborts refine the code but never the status', () => {
    expect(classifySendRejection(new Error('x'), { ...NO_STAGE, abortReason: 'oversize' })).toEqual({
      status: 'failed',
      failureCode: 'oversize',
    });
    expect(classifySendRejection(new Error('x'), { ...NO_STAGE, abortReason: 'size_mismatch' })).toEqual({
      status: 'failed',
      failureCode: 'size_mismatch',
    });
  });

  it('row 6: a mid-body upstream failure', () => {
    expect(classifySendRejection(new Error('x'), { ...NO_STAGE, upstreamErrored: true })).toEqual({
      status: 'failed',
      failureCode: 'upstream_unavailable',
    });
  });

  it('rows 9 and 10: the catch-all is TOTAL and resolved purely by stage', () => {
    expect(classifySendRejection(new Error('anything'), NO_STAGE)).toEqual({
      status: 'failed',
      failureCode: 'smtp_error',
    });
    expect(classifySendRejection(new Error('anything'), { ...NO_STAGE, reachedEnd: true })).toEqual({
      status: 'indeterminate',
      failureCode: null,
    });
  });

  it('NEVER reads err.code or err.command — mutating them alone cannot change the outcome', () => {
    // nodemailer raises at least nine distinct codes and that set is not a closed union; an
    // `EAUTH` must land on `failed` through the same rule as a dropped socket.
    const codes = ['ECONNECTION', 'ESOCKET', 'ETLS', 'EDNS', 'EAUTH', 'EENVELOPE', 'EMESSAGE', 'ESTREAM', 'EREQUIRETLS', 'E_FUTURE_UNKNOWN'];
    const before = codes.map((code) => classifySendRejection(Object.assign(new Error('x'), { code, command: 'CONN' }), NO_STAGE));
    expect(new Set(before.map((o) => JSON.stringify(o))).size).toBe(1);
    expect(before[0]).toEqual({ status: 'failed', failureCode: 'smtp_error' });

    const after = codes.map((code) =>
      classifySendRejection(Object.assign(new Error('x'), { code, command: 'DATA' }), { ...NO_STAGE, reachedEnd: true }),
    );
    expect(new Set(after.map((o) => JSON.stringify(o))).size).toBe(1);
    expect(after[0]).toEqual({ status: 'indeterminate', failureCode: null });
  });

  it('rows 7 and 8: the deadline picks by stage — indeterminate once every byte was handed over', () => {
    expect(deadlineOutcome({ reachedEnd: false })).toEqual({ status: 'failed', failureCode: 'attempt_timeout' });
    expect(deadlineOutcome({ reachedEnd: true })).toEqual({ status: 'indeterminate', failureCode: null });
  });

  it('every producing condition yields a LISTED failure code, and every code has a producer', () => {
    const produced = new Set<string>();
    const record = (o: { failureCode: string | null }) => {
      if (o.failureCode !== null) produced.add(o.failureCode);
    };
    // Row 0 is produced by the service (the open rejecting); named here so the correspondence is
    // over the whole enumerated set rather than only the classifier's own rows.
    produced.add('upstream_unavailable');
    // The lease sweep is the sole producer of `lease_expired`; the admission suite drives it.
    produced.add('lease_expired');
    record(classifySendRejection({ responseCode: 550 }, NO_STAGE)); // rows 2/3
    record(classifySendRejection(new Error('x'), { ...NO_STAGE, abortReason: 'oversize' })); // row 4
    record(classifySendRejection(new Error('x'), { ...NO_STAGE, abortReason: 'size_mismatch' })); // row 5
    record(classifySendRejection(new Error('x'), { ...NO_STAGE, upstreamErrored: true })); // row 6
    record(classifySendRejection(new Error('x'), NO_STAGE)); // row 9
    record(deadlineOutcome({ reachedEnd: false })); // row 7
    record(deadlineOutcome({ reachedEnd: true })); // row 8 — no code
    record(classifySendRejection(new Error('x'), { ...NO_STAGE, reachedEnd: true })); // row 10 — no code

    // Both directions: no producer mints an unlisted code…
    for (const code of produced) expect(KINDLE_SEND_FAILURE_CODES).toContain(code);
    // …and no listed code is dead (a dead code invites an implementation-defined extra outcome).
    expect([...produced].sort()).toEqual([...KINDLE_SEND_FAILURE_CODES].sort());
  });
});

describe('the submission stage boundary is the readable `end`, NOT `_flush()`', () => {
  /** Feed the transform a complete body and end the writable side, WITHOUT draining it. */
  async function flushedButUndrained(bytes: number): Promise<CountingEpubStream> {
    const transform = new CountingEpubStream(bytes);
    transform.write(Buffer.alloc(bytes, 0x41));
    transform.end();
    // `_flush()` runs off the writable side ending; a body under the readable highWaterMark is
    // fully accepted, so this settles without any consumer having read a single byte.
    await new Promise((resolve) => setTimeout(resolve, 5));
    return transform;
  }

  it('is FALSE while every byte still sits un-consumed in the readable buffer', async () => {
    const transform = await flushedButUndrained(4096);
    // `_flush()` has passed — the integrity check ran and the counter is complete…
    expect(transform.bytes).toBe(4096);
    expect(transform.abortReason).toBeNull();
    // …but nodemailer has read nothing, so nothing has reached the socket. Reporting the stage as
    // reached here is what would misclassify a disconnect in this gap as `indeterminate`.
    expect(transform.readableEnded).toBe(false);
    expect(transform.reachedEnd).toBe(false);
  });

  it('flips to TRUE only once the consumer has drained it', async () => {
    const transform = await flushedButUndrained(4096);
    expect(transform.reachedEnd).toBe(false);
    let drained = 0;
    transform.on('data', (chunk: Buffer) => {
      drained += chunk.length;
    });
    await new Promise((resolve) => transform.on('end', resolve));
    expect(drained).toBe(4096);
    expect(transform.reachedEnd).toBe(true);
  });

  it('stays FALSE when our own integrity check aborted before EOF', async () => {
    const transform = new CountingEpubStream(99);
    transform.on('error', () => {});
    transform.write(Buffer.alloc(10, 0x41));
    transform.end();
    transform.resume();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(transform.abortReason).toBe('size_mismatch');
    expect(transform.reachedEnd).toBe(false);
  });

  // The boundary through the REAL classification path: a transport that takes the attachment,
  // stops consuming it, and then rejects with no server reply. `_flush()` has passed, so a
  // flush-based flag reports `indeterminate`; the honest answer is `failed`, because not one
  // attachment byte was submitted and a retry is provably safe.
  it('classifies an un-consumed attachment as FAILED, never indeterminate', async () => {
    const h = await buildKindleSendHarness();
    h.companions.value = { format: 'epub', sizeBytes: 4096 };
    h.stream.bytes = new Uint8Array(4096);
    h.transports.factoryOverride = () => ({
      // Never reads the attachment — the connection died before the transport could consume it.
      sendMail: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        throw new Error('connection reset');
      },
      close: () => {},
    });

    expect(await h.svc.send(h.user, BOOK)).toEqual({ outcome: 'failed' });
    const [row] = await h.rowsFor(BOOK);
    expect(row).toMatchObject({ status: 'failed', failureCode: 'smtp_error' });
  });

  it('still classifies a FULLY consumed attachment as indeterminate on a reply-less rejection', async () => {
    // The mirror case, so the fix cannot be satisfied by simply never reporting the stage.
    const h = await buildKindleSendHarness();
    h.transports.reply = () => Promise.reject(new Error('connection lost after DATA'));
    expect(await h.svc.send(h.user, BOOK)).toEqual({ outcome: 'indeterminate' });
    expect((await h.rowsFor(BOOK))[0]).toMatchObject({ status: 'indeterminate', failureCode: null });
  });
});

describe('message copy — fixed, with no user-supplied text and no HTML surface', () => {
  it('carries the caller’s title ONLY on the attachment filename', async () => {
    const h = await buildKindleSendHarness();
    h.companions.value = { format: 'epub', sizeBytes: 4 };
    await h.svc.send(h.user, BOOK, { title: 'Hostile <script>alert(1)</script> Title' });

    const message = h.transports.messages[0];
    expect(message?.subject).toBe(KINDLE_SEND_SUBJECT);
    expect(message?.text).toBe(KINDLE_SEND_TEXT);
    // No `html` part at all — nothing to inject into and no link to rewrite.
    expect(message && 'html' in message).toBe(false);
    // The title reaches exactly one field, sanitized.
    expect(message?.attachments[0]?.filename).toContain('scriptalert(1)script');
    expect(`${message?.subject} ${message?.text}`).not.toContain('script');
  });

  it('falls back to the book id when no title is supplied', async () => {
    const h = await buildKindleSendHarness();
    await h.svc.send(h.user, BOOK);
    expect(h.transports.messages[0]?.attachments[0]?.filename).toBe(`${BOOK}.epub`);
  });

  it('sends to the STORED address and from the selected notifier’s config.from, verbatim', async () => {
    const h = await buildKindleSendHarness();
    h.settings.sender = {
      mailbox: 'Bot@Ex.com',
      config: emailRuntimeConfig({ from: 'Narratorr <Bot@Ex.com>' }),
    };
    // The stored address is lowercased at write time; the fake server echoes it back verbatim.
    h.transports.reply = (m) => Promise.resolve({ accepted: [m.to], rejected: [] });
    expect(await h.svc.send(h.user, BOOK)).toEqual({ outcome: 'sent' });
    expect(h.transports.messages[0]?.to).toBe('reader@kindle.com');
    expect(h.transports.messages[0]?.from).toBe('Narratorr <Bot@Ex.com>');
  });
});
