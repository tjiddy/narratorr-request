import { NarratorrClient, type INarratorrClient, type NarratorrClientConfig } from './narratorr-client.js';
import { NarratorrStreamClient, type IEbookStreamClient } from './narratorr-stream-client.js';
import { NarratorrClientHolder } from './narratorr-client-holder.js';
import { FeatureService } from './feature.service.js';

/**
 * The two halves of ONE narratorr connection. They are only ever created together (see
 * {@link buildNarratorrClients}) and only ever installed together ({@link NarratorrClientHolder.set}),
 * so there is no state in which the JSON client points at server B while the stream client still
 * points at server A.
 */
export interface NarratorrClientPair {
  readonly json: INarratorrClient;
  readonly stream: IEbookStreamClient;
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

/** The boot-time narratorr graph: the live connection plus the resolver keyed to it. */
export interface NarratorrConnection {
  /** The swappable connection every service holds — never a concrete client. */
  narratorr: NarratorrClientHolder;
  /** The capability resolver, probing THROUGH {@link narratorr} and keyed to ITS generation. */
  features: FeatureService;
}

/**
 * Build the whole boot-time narratorr graph from one already-read config (null = unconfigured).
 *
 * This exists as a seam because `src/server/index.ts` auto-runs `main()` on import and so can
 * never be executed by a test: without it, the two invariants below would live only in
 * unreachable composition-root code and could drift from every unit that mirrors them.
 *   • Both halves of the connection come from ONE `buildNarratorrClients` call, so they can't be
 *     built from different credentials.
 *   • `FeatureService` receives THE SAME holder as its capability client and as its generation
 *     source — a resolver keyed to a different holder would never see a live reconnect.
 */
export function buildNarratorrConnection(cfg: { url: string; apiKey: string } | null): NarratorrConnection {
  const narratorr = new NarratorrClientHolder(
    cfg ? buildNarratorrClients({ baseUrl: cfg.url, apiKey: cfg.apiKey }) : null,
  );
  return { narratorr, features: new FeatureService(narratorr, narratorr) };
}
