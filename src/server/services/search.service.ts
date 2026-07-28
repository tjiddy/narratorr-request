import type { V1AudibleResult } from '../../shared/schemas/v1/metadata.js';
import type { INarratorrClient } from './narratorr-client.js';
import { tooManyRequests } from '../util/errors.js';

export interface SearchServiceOptions {
  /** How long a query's results are cached (shared across users). */
  cacheTtlMs?: number;
  /** Max distinct upstream searches per user per window. */
  ratePerWindow?: number;
  windowMs?: number;
  /** Cap on cached query keys (oldest evicted). */
  maxCacheEntries?: number;
}

interface CacheEntry {
  at: number;
  data: V1AudibleResult[];
}

interface RateState {
  windowStart: number;
  count: number;
}

/**
 * Front door for public Audible search. Protects Narratorr's upstream metadata
 * provider (Codex risk #4) with a shared TTL cache keyed on the normalized query
 * and a per-user fixed-window throttle. Cache hits do NOT consume the throttle —
 * a user re-running the same query is cheap; only distinct upstream calls count.
 *
 * KNOWN LIMITATION (revisit when narratorr #1537 deploys): once results carry the
 * `library` cross-reference, the shared cache also snapshots that (mutable) status for
 * up to cacheTtlMs. The acting requester is masked by their own per-user `requestedStatus`
 * (uncached), so for them it's correct; for OTHER users a freshly-acquired/imported book
 * can show a stale "Request" badge until the entry expires. Harmless today (the field is
 * absent until #1537 ships) and bounded (≤cacheTtlMs); a duplicate request is deduped
 * downstream (narratorr is idempotent by ASIN, we dedupe per-(user,asin)). The real fix
 * (separate the static-metadata cache from the live library annotation) is deferred until
 * the field is live and we can measure actual staleness — not built speculatively here.
 * The nested `library.companionEbook` (narratorr #1961) rides along in that same snapshot,
 * so a book that gains a companion ebook can likewise read stale for up to cacheTtlMs —
 * same bound, same deferral, no behavior change here.
 */
export class SearchService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly rate = new Map<number, RateState>();
  private readonly cacheTtlMs: number;
  private readonly ratePerWindow: number;
  private readonly windowMs: number;
  private readonly maxCacheEntries: number;

  constructor(
    private readonly client: INarratorrClient,
    opts: SearchServiceOptions = {},
  ) {
    this.cacheTtlMs = opts.cacheTtlMs ?? 60_000;
    this.ratePerWindow = opts.ratePerWindow ?? 15;
    this.windowMs = opts.windowMs ?? 30_000;
    this.maxCacheEntries = opts.maxCacheEntries ?? 200;
  }

  async search(userId: number, query: string, nowMs = Date.now()): Promise<V1AudibleResult[]> {
    const key = query.trim().toLowerCase();

    const cached = this.cache.get(key);
    if (cached && nowMs - cached.at < this.cacheTtlMs) return cached.data;

    this.consumeToken(userId, nowMs);

    const data = await this.client.searchMetadata(query);
    this.cache.set(key, { at: nowMs, data });
    this.evictIfNeeded();
    return data;
  }

  private consumeToken(userId: number, nowMs: number): void {
    const state = this.rate.get(userId);
    if (!state || nowMs - state.windowStart >= this.windowMs) {
      this.rate.set(userId, { windowStart: nowMs, count: 1 });
      return;
    }
    if (state.count >= this.ratePerWindow) {
      throw tooManyRequests('SEARCH_THROTTLED', 'Too many searches — slow down a moment.');
    }
    state.count += 1;
  }

  private evictIfNeeded(): void {
    if (this.cache.size <= this.maxCacheEntries) return;
    // Map preserves insertion order — drop the oldest until under cap.
    const overflow = this.cache.size - this.maxCacheEntries;
    let removed = 0;
    for (const k of this.cache.keys()) {
      if (removed >= overflow) break;
      this.cache.delete(k);
      removed += 1;
    }
  }
}
