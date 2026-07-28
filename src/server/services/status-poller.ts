import { Cron } from 'croner';
import type { FastifyBaseLogger } from 'fastify';
import type { RequestService } from './request.service.js';
import { BOOK_VANISHED_REASON } from './request.service.js';
import type { IBookStatusClient } from './narratorr-client.js';
import { NarratorrError } from './narratorr-client.js';

export interface StatusPollerOptions {
  requests: RequestService;
  client: IBookStatusClient;
  logger: FastifyBaseLogger;
  /** Poll cadence (seconds). */
  intervalSeconds?: number;
  /** Max acquisitions probed per tick. */
  batchSize?: number;
  /** Upper bound on the random per-call delay that spreads upstream load (ms). */
  jitterMs?: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Reconciles in-flight requests (`acquiring`) against Narratorr by polling
 * `GET /api/v1/books/:publicId` in jittered batches (PLAN decision #3 — poll,
 * don't tight-loop; SSE is key-unreachable per S7). Consecutive upstream
 * failures trigger exponential tick-skipping so a flapping Narratorr isn't
 * hammered. A 404 on a book marks the request failed.
 */
export class StatusPoller {
  private readonly requests: RequestService;
  private readonly client: IBookStatusClient;
  private readonly logger: FastifyBaseLogger;
  private readonly batchSize: number;
  private readonly jitterMs: number;
  private readonly intervalSeconds: number;
  private job: Cron | null = null;
  private failureStreak = 0;
  private skipTicks = 0;

  constructor(opts: StatusPollerOptions) {
    this.requests = opts.requests;
    this.client = opts.client;
    this.logger = opts.logger;
    this.batchSize = opts.batchSize ?? 25;
    this.jitterMs = opts.jitterMs ?? 250;
    this.intervalSeconds = opts.intervalSeconds ?? 15;
  }

  start(): void {
    if (this.job) return;
    // `protect: true` prevents overlapping runs if a tick runs long.
    this.job = new Cron(`*/${this.intervalSeconds} * * * * *`, { protect: true, name: 'status-poller' }, () =>
      this.tick(),
    );
    this.logger.info(`status-poller started (every ${this.intervalSeconds}s)`);
  }

  stop(): void {
    this.job?.stop();
    this.job = null;
  }

  private async tick(): Promise<void> {
    if (this.skipTicks > 0) {
      this.skipTicks -= 1;
      return;
    }
    try {
      const { checked, transitioned, upstreamErrors } = await this.pollOnce();
      if (upstreamErrors > 0 && transitioned === 0 && checked > 0) {
        this.backoff();
      } else {
        this.failureStreak = 0;
      }
    } catch (err) {
      this.logger.error({ err }, 'status-poller tick failed');
      this.backoff();
    }
  }

  private backoff(): void {
    this.failureStreak += 1;
    // Skip 1, 2, 4, … ticks (capped) before trying again.
    this.skipTicks = Math.min(2 ** (this.failureStreak - 1), 8);
    this.logger.warn(`status-poller backing off ${this.skipTicks} tick(s) after ${this.failureStreak} failure(s)`);
  }

  /**
   * One reconciliation pass over all `acquiring` requests. Returns counts so the
   * tick wrapper can decide whether to back off. Safe to call directly in tests.
   */
  async pollOnce(): Promise<{ checked: number; transitioned: number; upstreamErrors: number }> {
    let transitioned = 0;
    let upstreamErrors = 0;

    // Self-heal requests stranded `approved` (process died between approval and
    // handoff). The handoff is idempotent by ASIN, so a re-run never double-adds.
    const stranded = await this.requests.findApprovedAwaitingHandoff(this.batchSize);
    for (const row of stranded) {
      try {
        const outcome = await this.requests.recoverHandoff(row);
        // Both a recovery and a TERMINAL failure are real reconciliations (the request reached
        // its correct state and, for `failed`, emitted request.failed once) — count them as
        // transitions, NOT upstream errors, so the backoff signal stays honest. Only a TRANSIENT
        // failure (recoverHandoff re-throws) is an upstream error worth retrying/backing off on.
        transitioned += 1;
        if (outcome === 'failed') {
          this.logger.warn({ request: row.publicId }, 'stranded approved request failed terminally during handoff recovery');
        } else {
          this.logger.info({ request: row.publicId }, 'recovered stranded approved request via handoff');
        }
      } catch (err) {
        upstreamErrors += 1;
        this.logger.warn({ request: row.publicId, err }, 'handoff recovery failed');
      }
    }

    const rows = await this.requests.findAcquiring(this.batchSize);

    for (const row of rows) {
      if (!row.narratorrBookId) continue;
      if (this.jitterMs > 0) await sleep(Math.floor(Math.random() * this.jitterMs));
      try {
        const book = await this.client.getBook(row.narratorrBookId);
        const next = await this.requests.applyBook(row, book);
        if (next) {
          transitioned += 1;
          this.logger.info({ request: row.publicId, status: next }, 'request status updated');
        }
      } catch (err) {
        if (err instanceof NarratorrError && err.upstreamStatus === 404) {
          // markFailed claims the edge atomically; only count/log when THIS call transitioned
          // it (a row another caller already failed returns false → no double count/emit).
          if (await this.requests.markFailed(row, BOOK_VANISHED_REASON)) {
            transitioned += 1;
            this.logger.warn({ request: row.publicId }, 'book vanished upstream — marked failed');
          }
        } else {
          upstreamErrors += 1;
          this.logger.warn({ request: row.publicId, err }, 'poll failed for request');
        }
      }
    }

    // Third pass: the durable requester availability-email sweep (issue #121). The SOLE sender of
    // the "your audiobook is ready" email — re-attempts opted-in `available` rows whose
    // `available_notified_at` marker is null and settles each on a terminal outcome, so a transient
    // SMTP outage or a crash between the `available` commit and the send never loses the email.
    // Runs LAST so the acquiring reconciliation (which may itself produce new `available` rows) is
    // already committed. Per-row send faults are swallowed inside the sweep; a sweep-level DB read
    // fault propagates to the tick's guard, which backs off like any other poll error — never
    // unwinding the transitions already committed above.
    await this.requests.sweepAvailableNotifications(this.batchSize);

    return { checked: rows.length, transitioned, upstreamErrors };
  }
}
