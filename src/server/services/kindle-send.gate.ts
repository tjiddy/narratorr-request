import { Mutex } from '../util/mutex.js';
import {
  KINDLE_SEND_STARTS_PER_MINUTE,
  KINDLE_SEND_START_WINDOW_MS,
  isInsideWindow,
} from './kindle-send.policy.js';
import type { KindleTerminalOutcome } from './kindle-send.transport.js';

/**
 * The three IN-PROCESS admission primitives Send-to-Kindle runs on (issue #148), kept together
 * because they share one property that is easy to lose sight of: all three are per-Node-process,
 * which is exactly why the app is one-replica-only for this feature. Nothing durable lives here.
 */

/**
 * The per-user start counter: a deque of start timestamps over a ROLLING window.
 *
 * Rolling rather than a fixed tumbling bucket, deliberately — a bucket admits 2× the cap across a
 * boundary (three at 0:59, three more at 1:00), which the literal "3 starts/user/minute" does not
 * permit. Per the one window convention, a start aged EXACTLY the window length is still inside it
 * and still occupies a slot.
 *
 * In-memory by design: there is nothing worth preserving across a restart, and a restart simply
 * gives the user their three starts back.
 */
export class MinuteStartCounter {
  private readonly starts = new Map<number, number[]>();

  /** Drop the expired timestamps for one user and return what remains. */
  private live(userId: number, nowMs: number): number[] {
    const live = (this.starts.get(userId) ?? []).filter((t) =>
      isInsideWindow(t, nowMs, KINDLE_SEND_START_WINDOW_MS),
    );
    if (live.length === 0) this.starts.delete(userId);
    else this.starts.set(userId, live);
    return live;
  }

  /** Whether a fresh start fits under the cap right now. Prunes as a side effect. */
  available(userId: number, nowMs: number): boolean {
    return this.live(userId, nowMs).length < KINDLE_SEND_STARTS_PER_MINUTE;
  }

  /**
   * Spend a slot. Called at the point the reservation insert is ATTEMPTED — so an active-unique
   * collision and an operational insert failure both consume one, and neither is ever refunded,
   * while a refusal that never reached the insert consumes nothing.
   */
  record(userId: number, nowMs: number): void {
    const live = this.live(userId, nowMs);
    live.push(nowMs);
    this.starts.set(userId, live);
  }
}

/** The per-user serialization entry. `waiters` is what makes cleanup identity-safe. */
interface LockEntry {
  readonly mutex: Mutex;
  waiters: number;
}

/**
 * Keyed per-user serialization with IDENTITY-SAFE cleanup.
 *
 * `waiters` is incremented BEFORE `run()` and decremented in a `finally`; the entry is deleted only
 * when the count reaches zero AND the entry still in the map is the one this attempt incremented. A
 * naive `finally { map.delete(key) }` is a defect: a slow predecessor settling after a successor
 * replaced the tail would delete the successor's entry, letting a later arrival run concurrently
 * with it. (The same identity-checked shape the companion-ebook in-flight slot uses.)
 */
export class KeyedUserLock {
  private readonly locks = new Map<number, LockEntry>();

  /** Users with a live entry — the receipt that the map does not grow unboundedly. */
  get size(): number {
    return this.locks.size;
  }

  run<T>(userId: number, fn: () => Promise<T>): Promise<T> {
    const existing = this.locks.get(userId);
    const entry: LockEntry = existing ?? { mutex: new Mutex(), waiters: 0 };
    if (!existing) this.locks.set(userId, entry);
    entry.waiters += 1;
    return entry.mutex.run(fn).finally(() => {
      entry.waiters -= 1;
      if (entry.waiters === 0 && this.locks.get(userId) === entry) this.locks.delete(userId);
    });
  }
}

/**
 * A single-assignment outcome slot with an OPEN producer set — the upstream open rejecting,
 * `sendMail` settling, the deadline firing, or any future producer with no change to this rule. The
 * FIRST writer chooses the terminal row; later writers are discarded.
 *
 * There is exactly ONE mechanism here — selection — because liveness is not its job: the critical
 * section still waits for `sendMail` to settle, so a late settlement cannot change the chosen
 * outcome but also cannot be abandoned. This is deliberately not a "what does producer X do in
 * phase Y" table: such a list has to be re-audited whenever a producer is added, and the missed
 * combination is always the defect.
 */
export class OutcomeSlot {
  private chosen: KindleTerminalOutcome | null = null;
  private readonly release: () => void;
  /** Resolves as soon as SOME producer has claimed the outcome. */
  readonly settled: Promise<void>;

  constructor() {
    let release = (): void => {};
    this.settled = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.release = release;
  }

  claim(outcome: KindleTerminalOutcome): void {
    if (this.chosen) return;
    this.chosen = outcome;
    this.release();
  }

  get value(): KindleTerminalOutcome | null {
    return this.chosen;
  }
}
