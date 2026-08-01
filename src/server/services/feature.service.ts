import { NarratorrError, type ICapabilityClient } from './narratorr-client.js';

/** A successful probe (either boolean) stays fresh for a minute. */
export const CAPABILITY_TTL_MS = 60_000;
/** A `404` (definitively unsupported — an old narratorr) is cached far longer. */
export const CAPABILITY_UNSUPPORTED_TTL_MS = 300_000;
/** How long a transient failure may keep serving the last KNOWN-GOOD value, from the last SUCCESS. */
export const CAPABILITY_STALE_WINDOW_MS = 900_000;

/**
 * An IMMUTABLE cache entry, stamped with the CONNECTION generation it was produced under. Nothing
 * ever mutates or clears an entry — installing a new connection retires every prior entry by
 * bumping that generation, which makes an entry whose `generation` differs simply unreadable
 * (issue #145: the swap IS the invalidation). That immutability is what
 * lets a probe capture its own generation's entry at start and still evaluate the TTL / stale
 * window against it when it settles, even if the connection changed in the meantime.
 *
 * `ttlMs` rides the entry because the freshness window is a property of HOW the value was
 * resolved, not of the value: a successful `false` (narratorr says the feature is off) is fresh
 * for 60s, while a `404` `false` (no such endpoint) is fresh for 5m.
 */
interface CacheEntry {
  readonly generation: number;
  readonly value: boolean;
  /** When this entry was resolved — the freshness stamp the TTL is measured from. */
  readonly resolvedAt: number;
  /** The anchor for the stale-serve window. Only a DEFINITIVE resolution advances it. */
  readonly lastSuccessAt: number;
  readonly ttlMs: number;
}

/** The single-flight slot: one probe per generation, joined by concurrent callers. */
interface InFlight {
  readonly generation: number;
  readonly promise: Promise<boolean>;
}

/**
 * The connection's monotonic generation counter — `NarratorrClientHolder` satisfies this
 * structurally. The resolver READS it and never owns one: a cache entry stamped with a
 * superseded connection is unreadable by construction, so the holder swap itself retires the
 * prior connection's entries and in-flight probes. There is deliberately no `invalidate()` to
 * call beside the swap, and therefore no window in which someone could forget to.
 */
export interface ConnectionGeneration {
  readonly generation: number;
}

/**
 * Resolves narratorr's companion-ebook CAPABILITY (issue #144) — the network-sourced half of
 * `ebooksEnabled` (the other half is the admin opt-in column, AND-ed at `/api/features`).
 *
 * The public resolve method is TOTAL: it returns a boolean and never rejects, so a narratorr
 * outage degrades the feature rather than 5xx'ing a polled endpoint. Every upstream outcome maps
 * to one of three dispositions, branched on `err.upstreamStatus` (NOT the code string — a Fastify
 * JSON 404 yields `HTTP_404` while a reverse-proxy HTML 404 page yields `NON_JSON`, and both are
 * genuinely "no such endpoint"):
 *   • `404`                        → UNSUPPORTED: a definitive `false`, cached 5m.
 *   • a parsed body                → definitive, cached 60s.
 *   • `NOT_CONFIGURED`             → an immediate `false` that records NOTHING — a fresh install
 *                                    with no narratorr saved must not burn the stale budget on a
 *                                    permanent condition.
 *   • `401`/`403`, CONTRACT_MISMATCH (a 200 body missing `companionEpub.enabled` is provider
 *     drift, not an old server), `NETWORK`, any other non-2xx → TRANSIENT: serve the last known
 *     value while its 15-minute window (anchored to the last SUCCESS, so consecutive failures can
 *     never extend it) is open, else fail closed.
 *
 * The narratorr client is read through the HOLDER (never a captured inner client) so a live
 * reconnect is observed. The holder guarantees the *next* call reaches the new server; its
 * generation guarantees the *previous* call's answer can't outlive the swap.
 */
export class FeatureService {
  private entry: CacheEntry | null = null;
  private inFlight: InFlight | null = null;

  constructor(
    private readonly narratorr: ICapabilityClient,
    /** The live connection — its generation is read per call, never captured. */
    private readonly connection: ConnectionGeneration,
  ) {}

  /**
   * Whether the connected narratorr supports companion ebooks. Never rejects.
   *
   * `nowMs` is injected the repo way (a trailing default parameter, as in `SearchService.search`
   * and `createSessionToken`) so TTL/expiry behavior is testable without fake timers.
   */
  async ebooksCapability(nowMs: number = Date.now()): Promise<boolean> {
    const generation = this.connection.generation;
    // Only this generation's entry is readable — a swap retires the previous one in place.
    const entry = this.entry?.generation === generation ? this.entry : null;
    if (entry && nowMs - entry.resolvedAt < entry.ttlMs) return entry.value;

    // Join an in-flight probe only when it belongs to the CURRENT generation; otherwise the
    // pre-swap flight is answering about the previous connection, so start a fresh one.
    const joined = this.inFlight?.generation === generation ? this.inFlight : null;
    if (joined) return joined.promise;

    const slot: InFlight = { generation, promise: this.probe(generation, entry, nowMs) };
    this.inFlight = slot;
    try {
      return await slot.promise;
    } finally {
      // Release in a `finally` so a rejecting probe can't wedge the resolver — and IDENTITY-CHECK
      // it, so a late-settling superseded probe cannot cancel the flight that replaced it.
      if (this.inFlight === slot) this.inFlight = null;
    }
  }

  /**
   * One upstream round-trip, mapped to a boolean. `entry` is the captured view of this probe's own
   * generation at start (immutable, so it is still intact when we settle): AC13's stale window is
   * evaluated against IT, not against whatever the shared slot holds now — which is what gives a
   * superseded flight's original waiters a well-defined answer about the connection they asked about.
   */
  private async probe(generation: number, entry: CacheEntry | null, nowMs: number): Promise<boolean> {
    try {
      const caps = await this.narratorr.getCapabilities();
      return this.install(generation, caps.companionEpub.enabled, nowMs, CAPABILITY_TTL_MS);
    } catch (err: unknown) {
      if (err instanceof NarratorrError) {
        // No narratorr saved at all: permanent-for-now, and deliberately NOT a transient failure —
        // it installs nothing, so it neither starts nor consumes a stale window.
        if (err.upstreamCode === 'NOT_CONFIGURED') return false;
        // The ONLY unsupported signal. Keyed on the STATUS: a proxy's HTML 404 page arrives as
        // `NON_JSON`, a Fastify default 404 body as `HTTP_404`, and both mean the same thing.
        if (err.upstreamStatus === 404) {
          return this.install(generation, false, nowMs, CAPABILITY_UNSUPPORTED_TTL_MS);
        }
      }
      // Transient (401/403, CONTRACT_MISMATCH, NETWORK, any other non-2xx, or a non-NarratorrError):
      // serve the last known value while its window — anchored to the last SUCCESS — is open. A
      // failure installs nothing, so a run of failures can never extend it. No readable entry
      // (including the first read after a connection swap) → fail closed immediately.
      if (entry && nowMs - entry.lastSuccessAt < CAPABILITY_STALE_WINDOW_MS) return entry.value;
      return false;
    }
  }

  /**
   * Install a DEFINITIVE resolution — but only if this probe's generation is still current. A
   * superseded probe's outcome is discarded wholesale: it installs no entry, advances no
   * `lastSuccessAt`, and (having installed nothing) counts as nothing against the new generation.
   * The value is still returned to the callers who asked under the old generation.
   */
  private install(generation: number, value: boolean, nowMs: number, ttlMs: number): boolean {
    if (generation === this.connection.generation) {
      this.entry = { generation, value, resolvedAt: nowMs, lastSuccessAt: nowMs, ttlMs };
    }
    return value;
  }
}
