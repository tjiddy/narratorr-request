import type { RequestDto } from '../../shared/schemas/request.js';
import type { V1CompanionEbook } from '../../shared/schemas/v1/companion-ebook.js';
import type { IBookStatusClient } from './narratorr-client.js';
import { resolveFeatures, type FeatureStateDeps } from './feature-state.js';
import type { ConnectionGeneration } from './feature.service.js';

/** A resolved companion (present or absent) stays fresh for a minute. */
export const COMPANION_TTL_MS = 60_000;
/**
 * A FAILED lookup is remembered for a much shorter window, so a recovering narratorr is picked up
 * quickly while a dead one still can't be polled per row at the list's 4s cadence. Same rule
 * `FeatureService` applies with `CAPABILITY_TTL_MS` vs `CAPABILITY_UNSUPPORTED_TTL_MS`: the
 * freshness window is a property of HOW the value was resolved, not of the value.
 */
export const COMPANION_FAILURE_TTL_MS = 15_000;
/** Distinct book ids looked up per `enrich()` call. Rows past the cap are answered `null`. */
export const MAX_COMPANION_LOOKUPS = 10;
/** Cached book ids (oldest evicted), matching `SearchService`'s default. */
export const MAX_COMPANION_CACHE_ENTRIES = 200;

/**
 * An IMMUTABLE cache entry stamped with the CONNECTION generation that produced it — an entry
 * whose generation differs from the current one is simply unreadable, so a Settings reconnect
 * retires every prior entry by construction and there is deliberately no `invalidate()`.
 *
 * `settledAt` is stamped when the lookup SETTLES, never when it starts. That is load-bearing
 * rather than stylistic: `NarratorrClient`'s request timeout is 15_000 ms — the same number as
 * {@link COMPANION_FAILURE_TTL_MS} — so a call-start stamp would install a failure entry that is
 * already expired the instant it lands and buy exactly zero protection.
 */
interface CacheEntry {
  readonly generation: number;
  readonly value: V1CompanionEbook | null;
  readonly settledAt: number;
  readonly ttlMs: number;
}

/** The single-flight slot: one open `getBook` per book id PER GENERATION, joined by callers. */
interface InFlight {
  readonly generation: number;
  readonly promise: Promise<V1CompanionEbook | null>;
}

/** The slice of the Fastify logger this service writes to (one bounded `warn` per capped call). */
export interface CompanionEbookLogger {
  warn(obj: object, msg?: string): void;
}

/**
 * Read-time companion-ebook enrichment for the caller's own request list (issue #147).
 *
 * narratorr exposes companions per book only (`GET /books/:id` → `V1Book.companionEbook`) — there
 * is no list or filter endpoint and none may be requested — so a list of `available` rows becomes
 * a small fan-out of per-book lookups. Both My Requests hooks poll every 4s, which is what makes
 * every property below load-bearing rather than decorative:
 *
 *   • TOTAL. {@link enrich} never throws and never rejects. Every failure path — the feature
 *     resolver, a rejected lookup, a contract mismatch, and the holder's SYNCHRONOUS
 *     `NOT_CONFIGURED` throw on a disconnect race — leaves the row at `companionEbook: null`.
 *   • ZERO per-book traffic while the feature is off, decided by the SAME `resolveFeatures` that
 *     `/api/features` and the download proxy use, so the three can never disagree.
 *   • NEGATIVE CACHING. "available row with no companion" is the common case; a positive-only
 *     cache would leave it uncached and re-poll it 15×/minute per row.
 *   • ONE open lookup per book id per generation. Nothing is cached until a lookup SETTLES, so
 *     without the in-flight slot a dead narratorr's 15s timeout would let the polls at t=4/8/12s
 *     each open their own duplicate of the call already in flight.
 *
 * The per-generation qualifier is deliberate and no global concurrency number is claimed: retired
 * generations are neither cancelled nor awaited, so an admin who saves the connection repeatedly
 * while lookups are pending can have one live flight per generation they created. That is
 * expected. What must hold — a superseded result is never installed under, nor read from, the
 * current generation, and the current generation opens at most one flight per id — is unaffected
 * by how many retired flights are in the air.
 */
export class CompanionEbookService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, InFlight>();

  constructor(
    /** Narrow slice — the poller's `getBook` only. Do NOT widen `INarratorrClient` for this. */
    private readonly narratorr: IBookStatusClient,
    /** The live connection — its generation is read per lookup, never captured at construction. */
    private readonly connection: ConnectionGeneration,
    /** The shared derived-feature inputs (`AppDeps` satisfies this by shape). */
    private readonly featureDeps: FeatureStateDeps,
    private readonly logger: CompanionEbookLogger,
    /**
     * The clock seam. Read for BOTH cache reads and the install stamp, so tests can advance a
     * counter instead of reaching for fake timers — which is what makes the deferred-settlement
     * cases deterministic. `enrich()` deliberately takes no `nowMs` parameter: a per-call stamp
     * could not express "when this lookup settled".
     */
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Annotate the `available` rows of one page with their companion ebook. Returns a NEW array;
   * the input DTOs are never mutated. Rows it does not enrich are passed through untouched (they
   * already carry `companionEbook: null` from `RequestService.toDto()`).
   */
  async enrich(dtos: RequestDto[]): Promise<RequestDto[]> {
    try {
      if (!(await resolveFeatures(this.featureDeps)).ebooksEnabled) return dtos;

      // Candidates are exactly the `available` rows that carry a book id, deduplicated by id —
      // two rows for the same book cost one upstream call.
      const ids: string[] = [];
      for (const dto of dtos) {
        if (dto.status !== 'available' || dto.narratorrBookId === null) continue;
        if (!ids.includes(dto.narratorrBookId)) ids.push(dto.narratorrBookId);
      }
      if (ids.length === 0) return dtos;

      const selected = ids.slice(0, MAX_COMPANION_LOOKUPS);
      if (ids.length > selected.length) {
        // ONCE per call, at warn, carrying the count — never per row and never as an error. The
        // rows beyond the cap simply render no affordance; they don't block the response.
        this.logger.warn(
          { dropped: ids.length - selected.length, cap: MAX_COMPANION_LOOKUPS },
          'companion-ebook lookups capped for one request list',
        );
      }

      // `allSettled`, so one bad book can never fail the list. Each lookup is created INSIDE an
      // async boundary (`lookup` is async), which is what keeps a synchronous holder throw —
      // `NarratorrClientHolder.getBook()` calls `require()` before it returns a promise — from
      // escaping while this list is still being built, where `allSettled` would never see it.
      const settled = await Promise.allSettled(selected.map((id) => this.get(id)));
      const byId = new Map<string, V1CompanionEbook | null>();
      selected.forEach((id, i) => {
        const outcome = settled[i];
        byId.set(id, outcome?.status === 'fulfilled' ? outcome.value : null);
      });

      return dtos.map((dto) => {
        if (dto.status !== 'available' || dto.narratorrBookId === null) return dto;
        const value = byId.get(dto.narratorrBookId);
        return value === undefined ? dto : { ...dto, companionEbook: value };
      });
    } catch {
      // Belt-and-braces on AC3's totality: nothing above is expected to throw, and if anything
      // ever does, an un-enriched list beats a 500 on a polled endpoint.
      return dtos;
    }
  }

  /**
   * The SINGLE-BOOK companion accessor: cache read → in-flight join → fresh flight, all scoped to
   * the CURRENT generation.
   *
   * Public (issue #148) so the Send-to-Kindle preflight reuses this exact resolver instead of
   * opening an uncached `getBook` per send — {@link enrich} calls it too, so both paths share ONE
   * cache, ONE in-flight slot and ONE generation rule, in either call order. `fetchOne` absorbs
   * every upstream failure — a rejection, a contract mismatch, and the holder's SYNCHRONOUS
   * `NOT_CONFIGURED` throw on a disconnect race — into a failure-TTL `null`, so a caller sees
   * "no companion" rather than an error, exactly as the enrichment path does.
   */
  async get(bookId: string): Promise<V1CompanionEbook | null> {
    const generation = this.connection.generation;

    const entry = this.cache.get(bookId);
    const readable = entry?.generation === generation ? entry : null;
    if (readable && this.now() - readable.settledAt < readable.ttlMs) return readable.value;

    // Join only a flight opened under THIS generation; a pre-swap flight is answering about the
    // previous server, so it must not answer for this one.
    const joined = this.inFlight.get(bookId);
    if (joined?.generation === generation) return joined.promise;

    const slot: InFlight = { generation, promise: this.fetchOne(bookId, generation) };
    this.inFlight.set(bookId, slot);
    try {
      return await slot.promise;
    } finally {
      // Released in a `finally` so a rejecting flight can't wedge the id — and IDENTITY-checked,
      // so a late-settling superseded flight cannot cancel the flight that replaced it.
      if (this.inFlight.get(bookId) === slot) this.inFlight.delete(bookId);
    }
  }

  /**
   * One upstream round-trip, mapped to a value and a TTL. `async`, so a SYNCHRONOUS throw from
   * the holder takes exactly the same disposition (and the same failure-TTL entry) as a rejected
   * promise. An ABSENT `companionEbook` key — a pre-#1961 narratorr, or drift caught by the
   * schema's `.catch(undefined)` — is indistinguishable from `null`, by contract.
   */
  private async fetchOne(bookId: string, generation: number): Promise<V1CompanionEbook | null> {
    try {
      const book = await this.narratorr.getBook(bookId);
      return this.install(bookId, generation, book.companionEbook ?? null, COMPANION_TTL_MS);
    } catch {
      return this.install(bookId, generation, null, COMPANION_FAILURE_TTL_MS);
    }
  }

  /**
   * Install a settled outcome — but only if this lookup's generation is still current. A
   * superseded outcome is discarded wholesale (it installs nothing and can overwrite nothing),
   * while still being returned to the callers who asked under the old generation.
   */
  private install(
    bookId: string,
    generation: number,
    value: V1CompanionEbook | null,
    ttlMs: number,
  ): V1CompanionEbook | null {
    if (generation === this.connection.generation) {
      this.cache.set(bookId, { generation, value, settledAt: this.now(), ttlMs });
      this.evictIfNeeded();
    }
    return value;
  }

  /** Oldest-first eviction over an insertion-ordered `Map`, exactly as `SearchService` does. */
  private evictIfNeeded(): void {
    if (this.cache.size <= MAX_COMPANION_CACHE_ENTRIES) return;
    const overflow = this.cache.size - MAX_COMPANION_CACHE_ENTRIES;
    let removed = 0;
    for (const key of this.cache.keys()) {
      if (removed >= overflow) break;
      this.cache.delete(key);
      removed += 1;
    }
  }
}
