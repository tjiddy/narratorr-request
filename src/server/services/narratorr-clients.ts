import { NarratorrClient, type INarratorrClient, type NarratorrClientConfig } from './narratorr-client.js';
import { NarratorrStreamClient, type IEbookStreamClient } from './narratorr-stream-client.js';

/**
 * The two halves of ONE narratorr connection. They are only ever created together (see
 * {@link buildNarratorrClients}) and only ever installed together ({@link NarratorrClientHolder.set}),
 * so there is no state in which the JSON client points at server B while the stream client still
 * points at server A.
 */
export interface NarratorrClientPair {
  json: INarratorrClient;
  stream: IEbookStreamClient;
}

/**
 * The single config → client-pair decision, used by BOTH construction seams (boot wiring in
 * `src/server/index.ts` and `reconfigure()` in `routes/settings.ts`). Taking one already-read
 * config is what makes "the two clients can never be built from different credentials"
 * structural rather than a convention two call sites have to remember.
 */
export function buildNarratorrClients(cfg: NarratorrClientConfig): NarratorrClientPair {
  return {
    json: new NarratorrClient(cfg),
    stream: new NarratorrStreamClient({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey }),
  };
}
