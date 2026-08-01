import { describe, it, expect, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { buildKindleSendHarness, emailRuntimeConfig, type KindleSendHarness } from '../test-support/kindle-send.js';
import { kindleSends } from '../../db/schema.js';

// Redaction is ABSOLUTE (issue #148): no audit row and no log line may contain an email address
// (recipient OR sender), SMTP response text, a filename, or content bytes. The audit row's only
// free-text fields are the book id and the enum-constrained failure code, and every log line is
// keyed on the user's `publicId` plus the book id.
//
// Everything below sweeps the WHOLE emitted surface — every column of every row, and every logged
// line — rather than checking the fields we happened to think of.

const BOOK = 'bk_redact';
const RECIPIENT = 'reader@kindle.com';
const SENDER = 'library@example.com';
const HOSTILE_TITLE = 'My Secret Diary';
const SMTP_TEXT = '550 5.1.1 <reader@kindle.com>: Recipient address rejected: user unknown';
/** A distinctive byte pattern in the EPUB body — content must never reach a row or a log. */
const CONTENT_SENTINEL = 'ZZCONTENTSENTINELZZ';

/** Every value the forbidden sweep looks for. */
const FORBIDDEN: Array<[string, string]> = [
  ['the recipient address', RECIPIENT],
  ['the sender address', SENDER],
  ['the SMTP response text', 'Recipient address rejected'],
  ['the attachment filename', HOSTILE_TITLE],
  ['content bytes', CONTENT_SENTINEL],
];

/** Dump EVERY column of EVERY audit row as one scannable string. */
async function dumpRows(h: KindleSendHarness): Promise<string> {
  return JSON.stringify(await h.rows());
}

function expectNoLeaks(where: string, haystack: string): void {
  for (const [label, needle] of FORBIDDEN) {
    expect(haystack, `${where} must not contain ${label}`).not.toContain(needle);
  }
}

/** A harness whose body carries the content sentinel and whose title is the hostile one. */
async function build(): Promise<KindleSendHarness> {
  const h = await buildKindleSendHarness();
  const body = Buffer.from(CONTENT_SENTINEL.repeat(4), 'utf8');
  h.companions.value = { format: 'epub', sizeBytes: body.byteLength };
  h.stream.bytes = new Uint8Array(body);
  h.settings.sender = { mailbox: SENDER, config: emailRuntimeConfig({ from: SENDER }) };
  return h;
}

describe('audit rows carry no address, no SMTP text, no filename and no content', () => {
  it('after a SENT attempt', async () => {
    const h = await build();
    expect(await h.svc.send(h.user, BOOK, { title: HOSTILE_TITLE })).toEqual({ outcome: 'sent' });
    const rows = await dumpRows(h);
    expectNoLeaks('a sent audit row', rows);
    // Positively: the row's only free text is the book id and the enum-constrained code.
    const [row] = await h.rows();
    expect(row).toMatchObject({ bookId: BOOK, status: 'sent', failureCode: null });
  });

  it('after a FAILED attempt whose server answered with a verbose rejection', async () => {
    const h = await build();
    h.transports.reply = () =>
      Promise.reject(Object.assign(new Error(SMTP_TEXT), { responseCode: 550, response: SMTP_TEXT }));
    expect(await h.svc.send(h.user, BOOK, { title: HOSTILE_TITLE })).toEqual({ outcome: 'failed' });
    expectNoLeaks('a failed audit row', await dumpRows(h));
    expect((await h.rows())[0]).toMatchObject({ failureCode: 'smtp_rejected' });
  });

  it('after an INDETERMINATE attempt', async () => {
    const h = await build();
    h.transports.reply = () => Promise.reject(new Error(`connection lost after ${SMTP_TEXT}`));
    // The transform reached `end` (the fake drains it), so a reply-less rejection is indeterminate.
    expect(await h.svc.send(h.user, BOOK, { title: HOSTILE_TITLE })).toEqual({ outcome: 'indeterminate' });
    expectNoLeaks('an indeterminate audit row', await dumpRows(h));
  });

  it('after a lease-swept row', async () => {
    const h = await build();
    await h.seedRow({ bookId: 'bk_stale', status: 'started', startedAtMs: h.now() - 60 * 60_000 });
    await h.svc.sweepExpiredLeasesAtBoot();
    expectNoLeaks('a lease-swept audit row', await dumpRows(h));
    expect((await h.rowsFor('bk_stale'))[0]).toMatchObject({ failureCode: 'lease_expired' });
  });
});

describe('log lines are keyed on publicId + book id only', () => {
  it('emits nothing forbidden across a sent, a rejected and an operational failure', async () => {
    const h = await build();
    await h.svc.send(h.user, BOOK, { title: HOSTILE_TITLE });

    h.transports.reply = () => Promise.reject(Object.assign(new Error(SMTP_TEXT), { responseCode: 550 }));
    h.advance(60_001);
    await h.svc.send(h.user, 'bk_two', { title: HOSTILE_TITLE });

    // The pre-reservation operational failure, whose injected message deliberately carries the
    // recipient and an SMTP response — a handler that logged the error object would leak it.
    h.settings.error = new Error(`settings unreadable for ${RECIPIENT}: ${SMTP_TEXT}`);
    await expect(h.svc.send(h.user, 'bk_three', { title: HOSTILE_TITLE })).rejects.toBeTruthy();

    expectNoLeaks('the emitted log', h.logger.text);
    // …and positively: the required context IS present, keyed on the PUBLIC id — never the
    // numeric user id, which is an internal handle.
    const admitted = h.logger.at('info').find((l) => l.msg?.includes('admitted'));
    expect(admitted?.obj).toMatchObject({ user: h.user.publicId, book: BOOK });
    expect(h.logger.text).not.toContain(`"user":${h.user.id}`);
  });

  it.each([
    ['a still-started row', 'orphaned'],
    ['an absent row', 'absent'],
    ['a rejected re-read', 'unknown'],
  ])('stays redacted on the post-admission %s branch', async (_label, marker) => {
    const h = await build();
    // Break BOTH terminal writes so the branch under test is reached.
    const realUpdate = h.db.update.bind(h.db);
    vi.spyOn(h.db, 'update').mockImplementation(((table: any) => {
      const real = realUpdate(table);
      const realSet = real.set.bind(real);
      real.set = ((vals: any) => {
        const q = realSet(vals);
        const realWhere = q.where.bind(q);
        q.where = ((cond: any) => {
          const w = realWhere(cond);
          if ((w as any).returning) {
            (w as any).returning = () => Promise.reject(new Error(`write failed for ${RECIPIENT}`));
          }
          return w;
        }) as any;
        return q;
      }) as any;
      return real;
    }) as any);

    if (marker === 'absent') {
      h.transports.reply = async (message) => {
        await h.db.delete(kindleSends).where(eq(kindleSends.bookId, BOOK));
        return { accepted: [message.to], rejected: [] };
      };
    }
    if (marker === 'unknown') {
      const realFindFirst = h.db.query.kindleSends.findFirst.bind(h.db.query.kindleSends);
      let reads = 0;
      vi.spyOn(h.db.query.kindleSends, 'findFirst').mockImplementation(((cfg: any) => {
        reads += 1;
        return reads === 1 ? realFindFirst(cfg) : Promise.reject(new Error(`re-read failed: ${SMTP_TEXT}`));
      }) as any);
    }

    await expect(h.svc.send(h.user, BOOK, { title: HOSTILE_TITLE })).rejects.toMatchObject({ statusCode: 500 });
    vi.restoreAllMocks();

    const line = h.logger.at('error').find((l) => l.msg?.includes(marker));
    expect(line, `an error-level ${marker} line must be emitted`).toBeDefined();
    // Exactly the safe context, and nothing else.
    expect(line?.obj).toEqual({ user: h.user.publicId, book: BOOK });
    expectNoLeaks(`the ${marker} log`, h.logger.text);
    expectNoLeaks(`the ${marker} rows`, await dumpRows(h));
  });
});
