import { describe, it, expect, vi } from 'vitest';
import { NarratorrClientHolder } from './narratorr-client-holder.js';
import type { INarratorrClient } from './narratorr-client.js';
import type { V1Book } from '../../shared/schemas/v1/books.js';
import type { V1System } from '../../shared/schemas/v1/system.js';
import type { V1Capabilities } from '../../shared/schemas/v1/capabilities.js';

// What every call should look like while the inner client is null — surfaced to our
// own clients as a 502 (server-to-server) carrying the NOT_CONFIGURED upstream code.
const NOT_CONFIGURED = { statusCode: 502, upstreamCode: 'NOT_CONFIGURED' };

const book: V1Book = { id: 'bk_1', title: 'A Book', authors: [], narrators: [], status: 'searching' };
const system: V1System = { version: 'v1.0.0' };
const capabilities: V1Capabilities = { companionEpub: { enabled: true } };

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
  });

  it('delegates each method to the inner client and returns its result once configured', async () => {
    const inner = fakeClient();
    const results = ['hit'];
    inner.searchMetadata.mockResolvedValue(results);
    const holder = new NarratorrClientHolder(inner);

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
  });

  it('re-arms the NOT_CONFIGURED throw after set(null)', async () => {
    const inner = fakeClient();
    const holder = new NarratorrClientHolder(inner);
    holder.set(null);

    expect(holder.configured).toBe(false);
    await expect(awaited(() => holder.searchMetadata('q'))).rejects.toMatchObject(NOT_CONFIGURED);
    await expect(awaited(() => holder.addBook('B1'))).rejects.toMatchObject(NOT_CONFIGURED);
    await expect(awaited(() => holder.getBook('bk_1'))).rejects.toMatchObject(NOT_CONFIGURED);
    await expect(awaited(() => holder.getSystem())).rejects.toMatchObject(NOT_CONFIGURED);
    // The capability probe (issue #144) must reach the SAME NOT_CONFIGURED signal — the resolver
    // branches on that code to answer `false` immediately without burning its stale window.
    await expect(awaited(() => holder.getCapabilities())).rejects.toMatchObject(NOT_CONFIGURED);
    // The disarmed inner client is never touched.
    expect(inner.searchMetadata).not.toHaveBeenCalled();
    expect(inner.addBook).not.toHaveBeenCalled();
    expect(inner.getBook).not.toHaveBeenCalled();
    expect(inner.getSystem).not.toHaveBeenCalled();
  });
});
