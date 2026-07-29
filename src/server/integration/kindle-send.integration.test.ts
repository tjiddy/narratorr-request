import { and, eq } from 'drizzle-orm';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import {
  startIntegrationScenario,
  expectAllUpstreamGets,
  expectKeyAccepted,
  INTEGRATION_KINDLE_ADDRESS,
  INTEGRATION_SENDER_FROM,
  INTEGRATION_SMTP_USER,
  type IntegrationScenario,
} from '../test-support/integration-harness.js';
import { kindleSends } from '../../db/schema.js';
import { KINDLE_SEND_DAILY_ACCEPTED } from '../services/kindle-send.policy.js';

// ---------------------------------------------------------------------------
// The cross-app integration suite, address → send → audit (issue #150).
//
// NO MSW is registered in this file, and nothing it imports registers any — the SMTP leg is a real
// `smtp-server` and the upstream leg a real `node:http` fake, for the same reason the download file
// states: MSW cannot exercise a body-read abort, and a `jsonTransport` stub can fabricate
// `accepted`/`rejected` but cannot prove a DATA that never completes leaves the receiver with
// nothing (curated learning `msw-cannot-test-body-read-abort`).
//
// Both fakes ENFORCE their credentials, which is what makes every assertion below discriminating:
// the api key at the narratorr boundary (AC1b) and SMTP AUTH at the mail boundary (AC2b). A
// regression that stops sending either turns these red instead of leaving them green against a
// permissive fake.
// ---------------------------------------------------------------------------

const BOOK = 'bk_sendable150';
const OTHER_BOOK = 'bk_sendable151';
const TITLE = 'Quiet Harbour';

function epubFixture(size: number): Buffer {
  const buf = Buffer.alloc(size, 0x41);
  buf.write('PK', 0, 'latin1');
  return buf;
}

const EPUB = epubFixture(2048);

/** narratorr's book resource, carrying the companion the send preflight sizes the attempt from. */
function bookBody(id: string, sizeBytes: number): unknown {
  return {
    id,
    title: TITLE,
    authors: [{ name: 'A. Writer' }],
    narrators: [{ name: 'N. Reader' }],
    status: 'imported',
    companionEbook: { format: 'epub', sizeBytes },
  };
}

/**
 * Pull the EPUB attachment out of a retained RFC822 message and decode it. nodemailer base64-encodes
 * a binary attachment, so byte equality here proves the whole pipeline delivered the real payload —
 * not merely that an attachment header was present.
 */
function decodeEpubAttachment(message: Buffer): Buffer {
  const text = message.toString('latin1');
  const typeAt = text.indexOf('application/epub+zip');
  expect(typeAt, 'the message carried no EPUB attachment part').toBeGreaterThan(-1);
  const bodyAt = text.indexOf('\r\n\r\n', typeAt);
  expect(bodyAt, 'the EPUB part had no body').toBeGreaterThan(-1);
  const rest = text.slice(bodyAt + 4);
  const boundaryAt = rest.search(/\r\n--/u);
  const encoded = (boundaryAt === -1 ? rest : rest.slice(0, boundaryAt)).replace(/\r\n/gu, '');
  return Buffer.from(encoded, 'base64');
}

/**
 * A FIXED instant for the whole file — the load-bearing isolation here, not a nicety. Three rolling
 * windows decide these scenarios (the 24h daily accepted quota, the 60s replay window, the 10min
 * reservation lease), the seeded audit rows are stamped against the same clock the service reads,
 * and session verification reads it too. A host clock step would otherwise change admission or
 * replay results for timing drift rather than for the behavior under test.
 *
 * `toFake: ['Date']` is the load-bearing part (curated learning `vitest-tofake-date-only`). Plain
 * fake timers would also fake `setTimeout`/`setImmediate`, stalling the listening Fastify instance,
 * libSQL and the real SMTP socket — a hang instead of an honest failure. `KindleSendService`'s own
 * `now` seam is deliberately NOT injected here: the harness must stay a near-copy of
 * `src/server/index.ts`'s wiring (AC3), which passes no clock, and freezing `Date` covers the
 * service, the seeded rows and the session in ONE mechanism.
 */
const FROZEN_NOW = new Date('2026-07-29T12:00:00.000Z');

let s: IntegrationScenario | null = null;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: FROZEN_NOW });
});

afterEach(async () => {
  // AC7: the app AND both fakes close together.
  await s?.close();
  s = null;
  // `vi.restoreAllMocks()` does NOT restore timers — without this the frozen clock leaks into the
  // rest of the run.
  vi.useRealTimers();
});

const get = (scenario: IntegrationScenario, path: string, cookie: string): Promise<Response> =>
  fetch(`${scenario.baseUrl}${path}`, { headers: { cookie } });

const patch = (scenario: IntegrationScenario, path: string, cookie: string, body: unknown): Promise<Response> =>
  fetch(`${scenario.baseUrl}${path}`, {
    method: 'PATCH',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const sendToKindle = (scenario: IntegrationScenario, bookId: string, cookie: string): Promise<Response> =>
  fetch(`${scenario.baseUrl}/api/ebooks/${bookId}/send-to-kindle`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ title: TITLE }),
  });

/** Every audit row for one `(user, book)`. */
const rowsFor = (scenario: IntegrationScenario, userId: number, bookId: string) =>
  scenario.db
    .select()
    .from(kindleSends)
    .where(and(eq(kindleSends.userId, userId), eq(kindleSends.bookId, bookId)));

describe('the happy path, end to end over real sockets', () => {
  it('saves an address, sends it, and records ONE redacted audit row', async () => {
    s = await startIntegrationScenario();
    s.upstream.books.set(BOOK, { status: 200, body: bookBody(BOOK, EPUB.byteLength) });
    s.upstream.companionEpub = { kind: 'body', bytes: EPUB, chunkSize: 256 };
    const { user, cookie } = await s.activeUser({ kindleEmail: null });

    // The same continuous path the download file starts from: the feature is on for this caller
    // before anything is sent.
    const features = await get(s, '/api/features', cookie);
    const featuresBody = await features.text();
    expect(JSON.parse(featuresBody)).toEqual({
      ebooksEnabled: true,
      kindleDeliveryAvailable: true,
      kindleSenderEmail: INTEGRATION_SENDER_FROM,
    });
    s.sweep('GET /api/features', features, featuresBody);

    // AC11 — the self-scoped carrier. `/api/me` is the ONE documented exemption, and it is exactly
    // ONE VALUE wide: the caller's own Kindle address is expected in this body, so only THAT
    // sentinel is exempted from the body surface. Every other sentinel — the narratorr key and URL,
    // the media paths, the SMTP credentials — keeps its body assertion here, and the exempted
    // address is still swept in the headers and in the logs.
    const carrier = { bodyExempt: [INTEGRATION_KINDLE_ADDRESS] };
    const saved = await patch(s, '/api/me', cookie, { kindleEmail: INTEGRATION_KINDLE_ADDRESS });
    const savedBody = await saved.text();
    expect(saved.status).toBe(200);
    expect(JSON.parse(savedBody).kindleEmail).toBe(INTEGRATION_KINDLE_ADDRESS);
    s.sweep('PATCH /api/me (the Kindle address is the documented carrier)', saved, savedBody, carrier);

    const me = await get(s, '/api/me', cookie);
    const meBody = await me.text();
    expect(JSON.parse(meBody).kindleEmail).toBe(INTEGRATION_KINDLE_ADDRESS);
    s.sweep('GET /api/me (the Kindle address is the documented carrier)', me, meBody, carrier);

    // AC12 — one authenticated, COMPLETE message carrying the real bytes.
    const send = await sendToKindle(s, BOOK, cookie);
    const sendBody = await send.text();
    expect(send.status).toBe(200);
    expect(JSON.parse(sendBody)).toEqual({ outcome: 'sent' });
    s.sweep('POST /api/ebooks/:bookId/send-to-kindle', send, sendBody);

    expect(s.smtp.transactions).toHaveLength(1);
    const tx = s.smtp.transactions[0]!;
    expect(tx.complete).toBe(true);
    // The AC2b receipt: `buildKindleTransport` attaches `auth` only when BOTH user and pass are
    // present, so this is what a dropped credential would fail on.
    expect(tx.username).toBe(INTEGRATION_SMTP_USER);
    expect(decodeEpubAttachment(tx.message).equals(EPUB)).toBe(true);

    const message = tx.message.toString('latin1');
    expect(message).toContain(`To: ${INTEGRATION_KINDLE_ADDRESS}`);
    expect(message).toContain(`From: ${INTEGRATION_SENDER_FROM}`);
    expect(tx.from).toBe(INTEGRATION_SENDER_FROM);

    // AC13 — accepted-recipient verification asserted AT THE BOUNDARY, case-insensitively.
    expect(tx.acceptedRecipients.map((a) => a.toLowerCase())).toContain(INTEGRATION_KINDLE_ADDRESS.toLowerCase());
    expect(s.smtp.recipientAttempts).toEqual([{ address: INTEGRATION_KINDLE_ADDRESS, accepted: true }]);
    expect(s.smtp.authFailures).toBe(0);
    expectKeyAccepted(s.upstream, `/api/v1/books/${BOOK}`);
    expectKeyAccepted(s.upstream, '/companion-epub');
    // Both upstream legs are GETs, asserted as a positive METHOD receipt — the fake refuses
    // anything else, so a client that changed verb cannot pass this suite.
    expectAllUpstreamGets(s.upstream);

    // AC14 — the audit row shape.
    const rows = await rowsFor(s, user.id, BOOK);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.status).toBe('sent');
    expect(row.finalizedAt).not.toBeNull();
    expect(row.failureCode).toBeNull();
    expect(row.byteCount).toBe(EPUB.byteLength);
    // The clock receipt: the service stamped this row from the FROZEN instant, so the rolling
    // windows every scenario in this file depends on are pinned rather than ambient. Removing the
    // `useFakeTimers` call fails HERE, instead of leaving a silently host-clock-dependent suite.
    expect(row.startedAt.getTime()).toBe(FROZEN_NOW.getTime());
    expect(row.finalizedAt?.getTime()).toBe(FROZEN_NOW.getTime());
    // The CLOSED column set — a new column carrying a recipient, a filename or an SMTP response
    // string would have to appear here first.
    expect(Object.keys(row).sort()).toEqual(
      ['bookId', 'byteCount', 'failureCode', 'finalizedAt', 'id', 'startedAt', 'status', 'userId'].sort(),
    );
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain(INTEGRATION_KINDLE_ADDRESS);
    expect(serialized).not.toContain('.epub');
    expect(serialized).not.toContain(TITLE);
    expect(serialized).not.toContain('250');
  }, 30_000);
});

describe('an SMTP rejection is an honest failure', () => {
  it('answers failed / smtp_rejected and leaves the daily ACCEPTED quota untouched AT THE CAP', async () => {
    s = await startIntegrationScenario();
    s.upstream.books.set(BOOK, { status: 200, body: bookBody(BOOK, EPUB.byteLength) });
    s.upstream.books.set(OTHER_BOOK, { status: 200, body: bookBody(OTHER_BOOK, EPUB.byteLength) });
    s.upstream.companionEpub = { kind: 'body', bytes: EPUB };
    const { user, cookie } = await s.activeUser({ kindleEmail: INTEGRATION_KINDLE_ADDRESS });

    // Seeded AT THE CAP, not in open space: with an empty audit table an implementation that
    // wrongly counted the rejected attempt would still admit the next send and the assertion below
    // would prove nothing. Nine in-window acceptances leave exactly one slot.
    const now = Date.now();
    await s.db.insert(kindleSends).values(
      Array.from({ length: KINDLE_SEND_DAILY_ACCEPTED - 1 }, (_, i) => ({
        userId: user.id,
        bookId: `bk_seeded${i}`,
        status: 'sent' as const,
        byteCount: 1,
        failureCode: null,
        startedAt: new Date(now - 2_000),
        finalizedAt: new Date(now - 1_000),
      })),
    );

    s.smtp.rejectRecipient = true;
    const rejected = await sendToKindle(s, BOOK, cookie);
    const rejectedBody = await rejected.text();
    expect(rejected.status).toBe(200);
    expect(JSON.parse(rejectedBody)).toEqual({ outcome: 'failed' });
    s.sweep('POST /api/ebooks/:bookId/send-to-kindle (RCPT rejected)', rejected, rejectedBody);

    const failedRows = await rowsFor(s, user.id, BOOK);
    expect(failedRows).toHaveLength(1);
    expect(failedRows[0]).toMatchObject({ status: 'failed', failureCode: 'smtp_rejected' });
    // The rejection reached RCPT and no message was ever completed.
    expect(s.smtp.recipientAttempts).toEqual([{ address: INTEGRATION_KINDLE_ADDRESS, accepted: false }]);
    expect(s.smtp.transactions.filter((t) => t.complete)).toHaveLength(0);

    // The receipt: the tenth slot is still free, so a DIFFERENT book still sends.
    s.smtp.rejectRecipient = false;
    const accepted = await sendToKindle(s, OTHER_BOOK, cookie);
    const acceptedBody = await accepted.text();
    expect(JSON.parse(acceptedBody)).toEqual({ outcome: 'sent' });
    s.sweep('POST /api/ebooks/:bookId/send-to-kindle (after a rejection)', accepted, acceptedBody);
    expect(s.smtp.transactions.filter((t) => t.complete)).toHaveLength(1);
  }, 30_000);
});

describe('a DATA rejection is a complete drain and an honest failure', () => {
  it('drains every attachment byte, rejects at DATA, and retains the transaction as INCOMPLETE', async () => {
    // The other rejection STAGE: RCPT refuses before a byte is sent, while this one accepts the
    // whole message and then answers 550. Both classify as `smtp_rejected` (the server replied), but
    // only this one proves the fake's drain-then-reject path — without it, deleting or reversing
    // `complete: !flags.rejectData` in `fake-smtp.ts` leaves the suite green.
    s = await startIntegrationScenario();
    s.upstream.books.set(BOOK, { status: 200, body: bookBody(BOOK, EPUB.byteLength) });
    s.upstream.companionEpub = { kind: 'body', bytes: EPUB, chunkSize: 256 };
    const { user, cookie } = await s.activeUser({ kindleEmail: INTEGRATION_KINDLE_ADDRESS });
    s.smtp.rejectData = true;

    const res = await sendToKindle(s, BOOK, cookie);
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(JSON.parse(body)).toEqual({ outcome: 'failed' });
    s.sweep('POST /api/ebooks/:bookId/send-to-kindle (DATA rejected)', res, body);

    expect(s.smtp.transactions).toHaveLength(1);
    const tx = s.smtp.transactions[0]!;
    // The recipient was ACCEPTED at RCPT — this is not the RCPT case wearing a different hat.
    expect(s.smtp.recipientAttempts).toEqual([{ address: INTEGRATION_KINDLE_ADDRESS, accepted: true }]);
    // DATA was fully drained under an authenticated session: every attachment byte reached the
    // server, byte for byte.
    expect(tx.username).toBe(INTEGRATION_SMTP_USER);
    expect(decodeEpubAttachment(tx.message).equals(EPUB)).toBe(true);
    // ...and it is still INCOMPLETE, because the server answered 550 instead of accepting. A drain
    // is not a delivery.
    expect(tx.complete).toBe(false);

    const rows = await rowsFor(s, user.id, BOOK);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'failed', failureCode: 'smtp_rejected' });
  }, 30_000);
});

describe('a replay inside the window returns the prior result', () => {
  it('answers with the prior terminal outcome, opening NO second SMTP transaction and no second row', async () => {
    s = await startIntegrationScenario();
    s.upstream.books.set(BOOK, { status: 200, body: bookBody(BOOK, EPUB.byteLength) });
    s.upstream.companionEpub = { kind: 'body', bytes: EPUB };
    const { user, cookie } = await s.activeUser({ kindleEmail: INTEGRATION_KINDLE_ADDRESS });

    const first = await sendToKindle(s, BOOK, cookie);
    const firstBody = await first.text();
    expect(JSON.parse(firstBody)).toEqual({ outcome: 'sent' });
    s.sweep('POST /api/ebooks/:bookId/send-to-kindle (first)', first, firstBody);

    const replay = await sendToKindle(s, BOOK, cookie);
    const replayBody = await replay.text();
    expect(replay.status).toBe(200);
    expect(JSON.parse(replayBody)).toEqual({ outcome: 'sent' });
    s.sweep('POST /api/ebooks/:bookId/send-to-kindle (replayed)', replay, replayBody);

    expect(s.smtp.transactions).toHaveLength(1);
    expect(await rowsFor(s, user.id, BOOK)).toHaveLength(1);
    // The replay never reached the mail server at all.
    expect(s.smtp.recipientAttempts).toHaveLength(1);
  }, 30_000);
});
