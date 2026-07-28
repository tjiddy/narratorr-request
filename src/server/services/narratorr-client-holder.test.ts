import { describe, it, expect, vi } from 'vitest';
import { NarratorrClientHolder } from './narratorr-client-holder.js';
import type { INarratorrClient } from './narratorr-client.js';
import type { NarratorrEbookStream } from './narratorr-stream-client.js';
import type { NarratorrClientPair } from './narratorr-clients.js';
import type { V1Book } from '../../shared/schemas/v1/books.js';
import type { V1System } from '../../shared/schemas/v1/system.js';
import type { V1Capabilities } from '../../shared/schemas/v1/capabilities.js';

// What every call should look like while the connection is null — surfaced to our
// own clients as a 502 (server-to-server) carrying the NOT_CONFIGURED upstream code.
const NOT_CONFIGURED = { statusCode: 502, upstreamCode: 'NOT_CONFIGURED' };

const book: V1Book = { id: 'bk_1', title: 'A Book', authors: [], narrators: [], status: 'searching' };
const system: V1System = { version: 'v1.0.0' };
const capabilities: V1Capabilities = { companionEpub: { enabled: true } };
const ebook: NarratorrEbookStream = {
  contentType: 'application/epub+zip',
  contentLength: 0,
  body: new ReadableStream<Uint8Array>({
    start(c) {
      c.close();
    },
  }),
};

// The holder's delegating methods aren't `async` — `require()` throws synchronously
// when unconfigured, which every caller observes as a rejection because they `await`.
// Modelling that here keeps the assertion on the awaited path.
const awaited = (fn: () => unknown) => Promise.resolve().then(fn);

/** A `vi.fn()`-backed inner client so delegation can be asserted with `toHaveBeenCalledWith`. */
function fakeClient(): INarratorrClient & {
  searchMetadata: ReturnType<typeof vi.fn>;
  addBook: ReturnType<typeof vi.fn>;
  getBook: ReturnType<typeof vi.fn>;
  getSystem: ReturnType<typeof vi.fn>;
  getCapabilities: ReturnType<typeof vi.fn>;
} {
  return {
    searchMetadata: vi.fn().mockResolvedValue([]),
    addBook: vi.fn().mockResolvedValue(book),
    getBook: vi.fn().mockResolvedValue(book),
    getSystem: vi.fn().mockResolvedValue(system),
    getCapabilities: vi.fn().mockResolvedValue(capabilities),
  };
}

/** The raw-stream half of a connection (issue #145) — its own slice, not part of INarratorrClient. */
function fakeStreamClient() {
  return {
    openCompanionEpub: vi.fn(
      async (_publicId: string, _opts?: { signal?: AbortSignal }): Promise<NarratorrEbookStream> => ebook,
    ),
  };
}

/** A whole connection: the two halves are only ever created and installed together. */
function fakePair(): NarratorrClientPair & {
  json: ReturnType<typeof fakeClient>;
  stream: ReturnType<typeof fakeStreamClient>;
} {
  return { json: fakeClient(), stream: fakeStreamClient() };
}

describe('NarratorrClientHolder', () => {
  it('rejects every call with NOT_CONFIGURED while unconfigured', async () => {
    const holder = new NarratorrClientHolder();
    expect(holder.configured).toBe(false);
    await expect(awaited(() => holder.searchMetadata('q'))).rejects.toMatchObject(NOT_CONFIGURED);
    await expect(awaited(() => holder.addBook('B1'))).rejects.toMatchObject(NOT_CONFIGURED);
    await expect(awaited(() => holder.getBook('bk_1'))).rejects.toMatchObject(NOT_CONFIGURED);
    await expect(awaited(() => holder.getSystem())).rejects.toMatchObject(NOT_CONFIGURED);
    // The capability probe (issue #144) must reach the SAME NOT_CONFIGURED signal — the resolver
    // branches on that code to answer `false` immediately without burning its stale window.
    await expect(awaited(() => holder.getCapabilities())).rejects.toMatchObject(NOT_CONFIGURED);
    // …and so must the raw stream (issue #145): the proxy route maps NOT_CONFIGURED like every
    // other consumer instead of crashing on a missing client.
    await expect(awaited(() => holder.openCompanionEpub('bk_1'))).rejects.toMatchObject(NOT_CONFIGURED);
  });

  it('delegates each method to the inner client and returns its result once configured', async () => {
    const pair = fakePair();
    const inner = pair.json;
    const results = ['hit'];
    inner.searchMetadata.mockResolvedValue(results);
    const holder = new NarratorrClientHolder(pair);

    expect(holder.configured).toBe(true);
    await expect(holder.searchMetadata('hail mary')).resolves.toBe(results);
    expect(inner.searchMetadata).toHaveBeenCalledWith('hail mary');
    await expect(holder.addBook('B07KCQDQR9')).resolves.toBe(book);
    expect(inner.addBook).toHaveBeenCalledWith('B07KCQDQR9');
    await expect(holder.getBook('bk_42')).resolves.toBe(book);
    expect(inner.getBook).toHaveBeenCalledWith('bk_42');
    await expect(holder.getSystem()).resolves.toBe(system);
    expect(inner.getSystem).toHaveBeenCalledWith();
    await expect(holder.getCapabilities()).resolves.toBe(capabilities);
    expect(inner.getCapabilities).toHaveBeenCalledWith();

    // The stream half delegates with BOTH args — the caller's abort signal is what lets the
    // proxy route cancel the upstream when the downstream consumer disconnects.
    const ac = new AbortController();
    await expect(holder.openCompanionEpub('bk_7', { signal: ac.signal })).resolves.toBe(ebook);
    expect(pair.stream.openCompanionEpub).toHaveBeenCalledWith('bk_7', { signal: ac.signal });
  });

  it('re-arms the NOT_CONFIGURED throw after set(null)', async () => {
    const pair = fakePair();
    const inner = pair.json;
    const holder = new NarratorrClientHolder(pair);
    holder.set(null);

    expect(holder.configured).toBe(false);
    await expect(awaited(() => holder.searchMetadata('q'))).rejects.toMatchObject(NOT_CONFIGURED);
    await expect(awaited(() => holder.addBook('B1'))).rejects.toMatchObject(NOT_CONFIGURED);
    await expect(awaited(() => holder.getBook('bk_1'))).rejects.toMatchObject(NOT_CONFIGURED);
    await expect(awaited(() => holder.getSystem())).rejects.toMatchObject(NOT_CONFIGURED);
    // The capability probe (issue #144) must reach the SAME NOT_CONFIGURED signal — the resolver
    // branches on that code to answer `false` immediately without burning its stale window.
    await expect(awaited(() => holder.getCapabilities())).rejects.toMatchObject(NOT_CONFIGURED);
    await expect(awaited(() => holder.openCompanionEpub('bk_1'))).rejects.toMatchObject(NOT_CONFIGURED);
    // The disarmed inner clients are never touched.
    expect(inner.searchMetadata).not.toHaveBeenCalled();
    expect(inner.addBook).not.toHaveBeenCalled();
    expect(inner.getBook).not.toHaveBeenCalled();
    expect(inner.getSystem).not.toHaveBeenCalled();
    expect(pair.stream.openCompanionEpub).not.toHaveBeenCalled();
  });
});

// Issue #145: the holder is the ONE swappable connection generation. Both halves and the counter
// move in a single synchronous assignment, so nothing can observe a half-swapped connection.
describe('NarratorrClientHolder — connection generation', () => {
  it('swaps both slots and bumps the generation in one step; set(null) does too', () => {
    const a = fakePair();
    const b = fakePair();
    const holder = new NarratorrClientHolder(a);
    expect(holder.generation).toBe(0);

    holder.set(b);
    expect(holder.generation).toBe(1);
    expect(holder.configured).toBe(true);

    holder.set(null);
    expect(holder.generation).toBe(2);
    expect(holder.configured).toBe(false);

    // Monotonic: re-installing a connection never rewinds the counter, so a cache entry stamped
    // with an earlier generation can never become readable again.
    holder.set(a);
    expect(holder.generation).toBe(3);
  });

  it('snapshots the installed pair — mutating the caller-owned object cannot half-swap it', async () => {
    // The generation is only meaningful if `set()` is the ONLY way the installed clients can
    // change. Storing the caller's object by reference would let a retained handle swap one half
    // (server B's stream against server A's JSON and cache generation) with no bump at all.
    const a = fakePair();
    const b = fakePair();
    // A deliberately mutable handle on the same shape the holder is handed.
    const retained: { json: typeof a.json; stream: typeof a.stream } = { json: a.json, stream: a.stream };
    const holder = new NarratorrClientHolder(retained);

    retained.stream = b.stream;
    retained.json = b.json;

    await holder.getBook('bk_1');
    await holder.openCompanionEpub('bk_1');
    expect(a.json.getBook).toHaveBeenCalledWith('bk_1');
    expect(a.stream.openCompanionEpub).toHaveBeenCalledWith('bk_1', undefined);
    expect(b.json.getBook).not.toHaveBeenCalled();
    expect(b.stream.openCompanionEpub).not.toHaveBeenCalled();
    expect(holder.generation).toBe(0); // nothing moved, so nothing was retired

    // Same guarantee on the `set()` path, not just the constructor.
    holder.set(retained);
    retained.stream = a.stream;
    await holder.openCompanionEpub('bk_2');
    expect(b.stream.openCompanionEpub).toHaveBeenCalledWith('bk_2', undefined);
    expect(a.stream.openCompanionEpub).toHaveBeenCalledTimes(1); // still just the first call
    expect(holder.generation).toBe(1);
  });

  it('a caller holding only the holder reaches the NEW clients on the very next call', async () => {
    // The "no service may retain a concrete client" guarantee, from the consumer's side: both
    // halves are re-read per call, so a swap needs no cooperation from the caller.
    const a = fakePair();
    const b = fakePair();
    const holder = new NarratorrClientHolder(a);

    await holder.getBook('bk_1');
    await holder.openCompanionEpub('bk_1');
    expect(a.json.getBook).toHaveBeenCalledTimes(1);
    expect(a.stream.openCompanionEpub).toHaveBeenCalledTimes(1);

    holder.set(b);
    await holder.getBook('bk_2');
    await holder.openCompanionEpub('bk_2');

    expect(b.json.getBook).toHaveBeenCalledWith('bk_2');
    expect(b.stream.openCompanionEpub).toHaveBeenCalledWith('bk_2', undefined);
    // Never the retired pair — a captured client would still be answering for server A.
    expect(a.json.getBook).toHaveBeenCalledTimes(1);
    expect(a.stream.openCompanionEpub).toHaveBeenCalledTimes(1);
  });
});
