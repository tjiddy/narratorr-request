import { NarratorrError, type INarratorrClient } from './narratorr-client.js';
import type { IEbookStreamClient, NarratorrEbookStream } from './narratorr-stream-client.js';
import type { NarratorrClientPair } from './narratorr-clients.js';

/**
 * The one swappable narratorr CONNECTION GENERATION. Services (RequestService, SearchService,
 * StatusPoller, FeatureService, the companion-ebook proxy) hold THIS — never a concrete client —
 * so saving the connection in the Settings UI rebuilds it live with no restart. While
 * unconfigured both inner clients are absent and every call fails with a clear NOT_CONFIGURED
 * error instead of crashing.
 *
 * Two properties everything downstream leans on:
 *   • ATOMIC swap. {@link set} replaces BOTH inner clients and bumps {@link generation} in one
 *     synchronous assignment, so no reader can ever observe the JSON client from one connection
 *     paired with the stream client (or the cached capability) of another.
 *   • The generation is the only cache key for connection-scoped state. `FeatureService` stamps
 *     its entries with it, which retires the previous connection's cached capability by
 *     construction — there is no invalidate() to call, and no window in which one could be missed.
 *     It follows that an UNCHANGED generation means the inner client instances are identity-equal:
 *     `set()` is the only writer, and it always bumps.
 */
export class NarratorrClientHolder implements INarratorrClient, IEbookStreamClient {
  private clients: NarratorrClientPair | null;
  private gen = 0;

  constructor(clients: NarratorrClientPair | null = null) {
    this.clients = clients;
  }

  /** Install (or clear) the whole connection. Both slots and the generation move together. */
  set(clients: NarratorrClientPair | null): void {
    this.clients = clients;
    this.gen += 1;
  }

  /** Monotonic connection generation. Never decreases; bumped by every {@link set}. */
  get generation(): number {
    return this.gen;
  }

  get configured(): boolean {
    return this.clients !== null;
  }

  private require(): NarratorrClientPair {
    if (!this.clients) {
      throw new NarratorrError(
        0,
        'NOT_CONFIGURED',
        "Narratorr isn't connected yet. An admin can set it up on the Settings page.",
      );
    }
    return this.clients;
  }

  searchMetadata(q: string) {
    return this.require().json.searchMetadata(q);
  }

  addBook(asin: string) {
    return this.require().json.addBook(asin);
  }

  getBook(publicId: string) {
    return this.require().json.getBook(publicId);
  }

  getSystem() {
    return this.require().json.getSystem();
  }

  getCapabilities() {
    return this.require().json.getCapabilities();
  }

  openCompanionEpub(publicId: string, opts?: { signal?: AbortSignal }): Promise<NarratorrEbookStream> {
    return this.require().stream.openCompanionEpub(publicId, opts);
  }
}
