import { NarratorrError, type INarratorrClient } from './narratorr-client.js';

/**
 * A swappable INarratorrClient. Services (RequestService, SearchService, StatusPoller)
 * hold THIS rather than a concrete client, so saving the narratorr connection in the
 * Settings UI rebuilds the inner client live — no restart. While unconfigured the inner
 * client is null and any call fails with a clear NOT_CONFIGURED error instead of crashing.
 */
export class NarratorrClientHolder implements INarratorrClient {
  private client: INarratorrClient | null;

  constructor(client: INarratorrClient | null = null) {
    this.client = client;
  }

  set(client: INarratorrClient | null): void {
    this.client = client;
  }

  get configured(): boolean {
    return this.client !== null;
  }

  private require(): INarratorrClient {
    if (!this.client) {
      throw new NarratorrError(
        0,
        'NOT_CONFIGURED',
        "Narratorr isn't connected yet. An admin can set it up on the Settings page.",
      );
    }
    return this.client;
  }

  searchMetadata(q: string) {
    return this.require().searchMetadata(q);
  }

  addBook(asin: string) {
    return this.require().addBook(asin);
  }

  getBook(publicId: string) {
    return this.require().getBook(publicId);
  }

  getSystem() {
    return this.require().getSystem();
  }

  getCapabilities() {
    return this.require().getCapabilities();
  }
}
