import { describe, it, expect, vi } from 'vitest';
import {
  CompanionEbookService,
  COMPANION_TTL_MS,
  COMPANION_FAILURE_TTL_MS,
  MAX_COMPANION_LOOKUPS,
  MAX_COMPANION_CACHE_ENTRIES,
} from './companion-ebook.service.js';
import type { FeatureStateDeps } from './feature-state.js';
import type { IBookStatusClient } from './narratorr-client.js';
import type { V1Book } from '../../shared/schemas/v1/books.js';
import type { V1CompanionEbook } from '../../shared/schemas/v1/companion-ebook.js';
import type { RequestDto, RequestStatus } from '../../shared/schemas/request.js';

// `CompanionEbookService` (issue #147). Everything here is driven through the injected clock and
// generation seams — no fake timers — because the properties under test are about WHEN an outcome
// settled and WHICH connection produced it, neither of which a wall clock can express.

const EPUB: V1CompanionEbook = { format: 'epub', sizeBytes: 4096 };

const dto = (over: Partial<RequestDto> = {}): RequestDto => ({
  publicId: 'rq_1',
  asin: 'B01',
  title: 'A Book',
  author: null,
  narrator: null,
  coverUrl: null,
  status: 'available',
  note: null,
  failureReason: null,
  requestedAt: '2026-01-01T00:00:00.000Z',
  decidedAt: null,
  narratorrBookId: 'bk_1',
  companionEbook: null,
  requester: { publicId: 'us_1', username: 'alice' },
  ...over,
});

const book = (id: string, companion?: V1CompanionEbook | null): V1Book => ({
  id,
  title: 'A Book',
  authors: [],
  narrators: [],
  status: 'imported',
  // Deliberately conditional: OMITTING the key models a pre-#1961 narratorr, which must be
  // indistinguishable from an explicit `null`.
  ...(companion !== undefined && { companionEbook: companion }),
});

/** A `getBook` stub whose responder may reject OR throw SYNCHRONOUSLY (the real holder path). */
class StubBooks implements IBookStatusClient {
  calls: string[] = [];
  responder: (id: string, call: number) => Promise<V1Book> = (id) => Promise.resolve(book(id, EPUB));

  getBook(id: string): Promise<V1Book> {
    this.calls.push(id);
    // NOT `async`, so a responder that throws synchronously throws out of `getBook` itself.
    return this.responder(id, this.calls.length);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Nothing awaits these until the test does; pre-attaching a no-op keeps a rejected deferred
  // from tripping node's unhandled-rejection detector between creation and use.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

/** Let every already-scheduled microtask/timer callback run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

interface Harness {
  svc: CompanionEbookService;
  books: StubBooks;
  warn: ReturnType<typeof vi.fn>;
  setNow(ms: number): void;
  bumpGeneration(): void;
}

function build(opts: { ebooksEnabled?: boolean } = {}): Harness {
  const books = new StubBooks();
  const enabled = opts.ebooksEnabled ?? true;
  const featureDeps: FeatureStateDeps = {
    connectorSettings: {
      getEbookSettings: () => Promise.resolve({ ebooksEnabled: enabled, kindleSender: null }),
    },
    features: { ebooksCapability: () => Promise.resolve(enabled) },
  };
  let now = 0;
  let generation = 0;
  const warn = vi.fn();
  const svc = new CompanionEbookService(
    books,
    {
      get generation() {
        return generation;
      },
    },
    featureDeps,
    { warn },
    () => now,
  );
  return {
    svc,
    books,
    warn,
    setNow: (ms) => {
      now = ms;
    },
    bumpGeneration: () => {
      generation += 1;
    },
  };
}

describe('CompanionEbookService.enrich — candidate selection', () => {
  it('returns the input untouched and makes ZERO getBook calls while the feature is off', async () => {
    // Asserted at the `getBook` level on purpose: the capability probe is FeatureService's
    // traffic (shared with /api/features), not this service's.
    const h = build({ ebooksEnabled: false });
    const rows = [dto(), dto({ publicId: 'rq_2', narratorrBookId: 'bk_2' })];

    const out = await h.svc.enrich(rows);

    expect(out).toEqual(rows);
    expect(h.books.calls).toEqual([]);
  });

  it('looks up only `available` rows that carry a book id', async () => {
    const h = build();
    const others: RequestStatus[] = ['pending', 'approved', 'acquiring', 'denied', 'failed'];
    const rows = [
      ...others.map((status, i) => dto({ publicId: `rq_${i}`, status, narratorrBookId: `bk_${i}` })),
      dto({ publicId: 'rq_nullid', status: 'available', narratorrBookId: null }),
      dto({ publicId: 'rq_ok', status: 'available', narratorrBookId: 'bk_ok' }),
    ];

    const out = await h.svc.enrich(rows);

    expect(h.books.calls).toEqual(['bk_ok']);
    expect(out.find((r) => r.publicId === 'rq_ok')?.companionEbook).toEqual(EPUB);
    for (const r of out.filter((r) => r.publicId !== 'rq_ok')) expect(r.companionEbook).toBeNull();
  });

  it('deduplicates by book id — two rows sharing one id cost exactly one call', async () => {
    const h = build();
    const rows = [dto({ publicId: 'rq_a' }), dto({ publicId: 'rq_b' })];

    const out = await h.svc.enrich(rows);

    expect(h.books.calls).toEqual(['bk_1']);
    expect(out.map((r) => r.companionEbook)).toEqual([EPUB, EPUB]);
  });

  it('caps distinct lookups and logs the drop exactly ONCE at warn with the count', async () => {
    const h = build();
    const over = 3;
    const rows = Array.from({ length: MAX_COMPANION_LOOKUPS + over }, (_, i) =>
      dto({ publicId: `rq_${i}`, narratorrBookId: `bk_${i}` }),
    );

    const out = await h.svc.enrich(rows);

    expect(h.books.calls).toHaveLength(MAX_COMPANION_LOOKUPS);
    expect(out.slice(0, MAX_COMPANION_LOOKUPS).every((r) => r.companionEbook !== null)).toBe(true);
    // Overflow rows are answered `null` rather than blocking the response.
    expect(out.slice(MAX_COMPANION_LOOKUPS).every((r) => r.companionEbook === null)).toBe(true);
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(h.warn).toHaveBeenCalledWith(expect.objectContaining({ dropped: over }), expect.any(String));
  });

  it('does not mutate the input DTOs', async () => {
    const h = build();
    const row = dto();
    await h.svc.enrich([row]);
    expect(row.companionEbook).toBeNull();
  });
});

describe('CompanionEbookService.enrich — totality', () => {
  it.each([
    ['upstream null', (id: string) => Promise.resolve(book(id, null))],
    ['an ABSENT companionEbook key (pre-#1961 narratorr)', (id: string) => Promise.resolve(book(id))],
    ['a REJECTED lookup', () => Promise.reject(new Error('network'))],
    [
      'a SYNCHRONOUS throw (the holder’s require() → NOT_CONFIGURED disconnect race)',
      () => {
        throw new Error('NOT_CONFIGURED');
      },
    ],
  ])('resolves with companionEbook: null for %s, leaving sibling rows enriched', async (_label, responder) => {
    const h = build();
    h.books.responder = (id, call) => (call === 1 ? responder(id) : Promise.resolve(book(id, EPUB)));
    const rows = [dto({ publicId: 'rq_bad', narratorrBookId: 'bk_bad' }), dto({ publicId: 'rq_ok', narratorrBookId: 'bk_ok' })];

    const out = await h.svc.enrich(rows);

    expect(out[0]?.companionEbook).toBeNull();
    expect(out[1]?.companionEbook).toEqual(EPUB);
  });

  it.each([
    ['a rejection', () => Promise.reject(new Error('network'))],
    [
      'a synchronous throw',
      () => {
        throw new Error('NOT_CONFIGURED');
      },
    ],
  ])('installs the SAME failure-TTL entry for %s', async (_label, responder) => {
    const h = build();
    h.books.responder = () => responder();

    await h.svc.enrich([dto()]);
    expect(h.books.calls).toHaveLength(1);

    // Inside the FAILURE window → no second call; past it → exactly one more.
    h.setNow(COMPANION_FAILURE_TTL_MS - 1);
    await h.svc.enrich([dto()]);
    expect(h.books.calls).toHaveLength(1);

    h.setNow(COMPANION_FAILURE_TTL_MS);
    await h.svc.enrich([dto()]);
    expect(h.books.calls).toHaveLength(2);
  });
});

describe('CompanionEbookService — caching', () => {
  it.each([
    ['a companion object', (id: string) => Promise.resolve(book(id, EPUB)), EPUB],
    ['upstream null', (id: string) => Promise.resolve(book(id, null)), null],
    ['an absent key', (id: string) => Promise.resolve(book(id)), null],
    ['a rejection', () => Promise.reject(new Error('nope')), null],
  ])('caches %s — a second enrich a tick later makes ZERO additional calls', async (_l, responder, expected) => {
    // Negative caching is the whole point: "available row with no companion" is the COMMON case,
    // and both My Requests hooks poll every 4s.
    const h = build();
    h.books.responder = (id) => responder(id);

    const first = await h.svc.enrich([dto()]);
    h.setNow(1);
    const second = await h.svc.enrich([dto()]);

    expect(h.books.calls).toHaveLength(1);
    expect(first[0]?.companionEbook).toEqual(expected);
    expect(second[0]?.companionEbook).toEqual(expected);
  });

  it('re-fetches a resolved entry exactly at COMPANION_TTL_MS, not just before', async () => {
    const h = build();
    await h.svc.enrich([dto()]);

    h.setNow(COMPANION_TTL_MS - 1);
    await h.svc.enrich([dto()]);
    expect(h.books.calls).toHaveLength(1);

    h.setNow(COMPANION_TTL_MS);
    await h.svc.enrich([dto()]);
    expect(h.books.calls).toHaveLength(2);
  });

  it('gives failures a genuinely SHORTER window than successes', async () => {
    // The two constants must differ, and the failure entry must use its own.
    expect(COMPANION_FAILURE_TTL_MS).toBeLessThan(COMPANION_TTL_MS);
    const h = build();
    h.books.responder = () => Promise.reject(new Error('down'));

    await h.svc.enrich([dto()]);
    // A moment where a SUCCESS would still be fresh but a failure must not be.
    h.setNow(COMPANION_FAILURE_TTL_MS);
    await h.svc.enrich([dto()]);

    expect(h.books.calls).toHaveLength(2);
  });

  it('evicts oldest-first past MAX_COMPANION_CACHE_ENTRIES', async () => {
    const h = build();
    const total = MAX_COMPANION_CACHE_ENTRIES + MAX_COMPANION_LOOKUPS;
    for (let i = 0; i < total; i += MAX_COMPANION_LOOKUPS) {
      await h.svc.enrich(
        Array.from({ length: MAX_COMPANION_LOOKUPS }, (_, k) =>
          dto({ publicId: `rq_${i + k}`, narratorrBookId: `bk_${i + k}` }),
        ),
      );
    }
    expect(h.books.calls).toHaveLength(total);

    // The oldest id was evicted → re-fetch; the newest is still cached → no call.
    await h.svc.enrich([dto({ narratorrBookId: 'bk_0' })]);
    expect(h.books.calls).toHaveLength(total + 1);
    await h.svc.enrich([dto({ narratorrBookId: `bk_${total - 1}` })]);
    expect(h.books.calls).toHaveLength(total + 1);
  });
});

describe('CompanionEbookService — in-flight slot and settlement anchoring', () => {
  it('joins one slow flight across the 4s poll cadence and stamps the failure at SETTLEMENT', async () => {
    // The case the whole design exists for. NarratorrClient's request timeout is 15_000ms — the
    // same number as COMPANION_FAILURE_TTL_MS — so a call-start stamp would install an entry that
    // is already expired the instant it lands.
    const h = build();
    const d = deferred<V1Book>();
    h.books.responder = () => d.promise;

    const calls = [h.svc.enrich([dto()])];
    await flush();
    for (const t of [4000, 8000, 12000]) {
      h.setNow(t);
      calls.push(h.svc.enrich([dto()]));
      await flush();
    }
    expect(h.books.calls).toHaveLength(1);

    h.setNow(15000);
    d.reject(new Error('timeout'));
    const results = await Promise.all(calls);
    expect(results.map((r) => r[0]?.companionEbook)).toEqual([null, null, null, null]);

    // Stamped at 15000 → fresh until 30000. Asserted through BEHAVIOR, which is what proves
    // settlement anchoring rather than call-start anchoring.
    h.setNow(25000);
    await h.svc.enrich([dto()]);
    expect(h.books.calls).toHaveLength(1);

    h.setNow(30001);
    await h.svc.enrich([dto()]);
    expect(h.books.calls).toHaveLength(2);
  });
});

describe('CompanionEbookService — connection generation', () => {
  it('does not serve a completed entry after a reconnect', async () => {
    const h = build();
    await h.svc.enrich([dto()]);
    expect(h.books.calls).toHaveLength(1);

    h.bumpGeneration();
    await h.svc.enrich([dto()]);
    expect(h.books.calls).toHaveLength(2);
  });

  it('answers a superseded flight’s own callers but installs nothing under the new generation', async () => {
    const h = build();
    const old = deferred<V1Book>();
    h.books.responder = (id, call) => (call === 1 ? old.promise : Promise.resolve(book(id, null)));

    const pending = h.svc.enrich([dto()]);
    await flush();
    h.bumpGeneration();
    old.resolve(book('bk_1', EPUB));

    // Its own callers still get a well-defined answer about the connection they asked about…
    expect((await pending)[0]?.companionEbook).toEqual(EPUB);
    // …but the new generation never serves the old server's data.
    const fresh = await h.svc.enrich([dto()]);
    expect(h.books.calls).toHaveLength(2);
    expect(fresh[0]?.companionEbook).toBeNull();
  });

  it('does not JOIN a superseded in-flight lookup (the overlap case)', async () => {
    const h = build();
    const old = deferred<V1Book>();
    h.books.responder = (id, call) => (call === 1 ? old.promise : Promise.resolve(book(id, null)));

    const pending = h.svc.enrich([dto()]);
    await flush();
    // The new call starts BEFORE the old one settles — what a completed-entry test can't exercise.
    h.bumpGeneration();
    const afterSwap = await h.svc.enrich([dto()]);

    expect(h.books.calls).toHaveLength(2);
    expect(afterSwap[0]?.companionEbook).toBeNull();

    old.resolve(book('bk_1', EPUB));
    expect((await pending)[0]?.companionEbook).toEqual(EPUB);

    // The old value is neither installed nor served under the new generation.
    const again = await h.svc.enrich([dto()]);
    expect(again[0]?.companionEbook).toBeNull();
    expect(h.books.calls).toHaveLength(2);
  });

  it('permits one live flight PER GENERATION across repeated reconnects, and still joins within one', async () => {
    // The per-generation invariant is a policy, not a global call cap: retired flights are neither
    // cancelled nor awaited, so three admin saves can legitimately leave three flights open.
    const h = build();
    const flights = [deferred<V1Book>(), deferred<V1Book>(), deferred<V1Book>()];
    h.books.responder = (_id, call) => flights[call - 1]!.promise;

    const g0 = h.svc.enrich([dto()]);
    await flush();
    h.bumpGeneration();
    const g1 = h.svc.enrich([dto()]);
    await flush();
    h.bumpGeneration();
    const g2 = h.svc.enrich([dto()]);
    await flush();
    // (a) three open flights for one id — CORRECT, not a violation.
    expect(h.books.calls).toHaveLength(3);

    // (b) a concurrent caller under G2 JOINS G2's flight rather than opening a fourth.
    const g2b = h.svc.enrich([dto()]);
    await flush();
    expect(h.books.calls).toHaveLength(3);

    // (c) resolving the retired flights installs nothing readable under G2.
    flights[0]!.resolve(book('bk_1', { format: 'epub', sizeBytes: 1 }));
    flights[1]!.resolve(book('bk_1', { format: 'epub', sizeBytes: 2 }));
    flights[2]!.resolve(book('bk_1', EPUB));

    expect((await g0)[0]?.companionEbook).toEqual({ format: 'epub', sizeBytes: 1 });
    expect((await g1)[0]?.companionEbook).toEqual({ format: 'epub', sizeBytes: 2 });
    expect((await g2)[0]?.companionEbook).toEqual(EPUB);
    expect((await g2b)[0]?.companionEbook).toEqual(EPUB);

    // G2 still serves only its OWN value, from cache.
    const served = await h.svc.enrich([dto()]);
    expect(served[0]?.companionEbook).toEqual(EPUB);
    expect(h.books.calls).toHaveLength(3);
  });
});
