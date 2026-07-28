import { describe, it, expect } from 'vitest';
import {
  FeatureService,
  CAPABILITY_TTL_MS,
  CAPABILITY_UNSUPPORTED_TTL_MS,
  CAPABILITY_STALE_WINDOW_MS,
} from './feature.service.js';
import { NarratorrError, type ICapabilityClient, type INarratorrClient } from './narratorr-client.js';
import { NarratorrClientHolder } from './narratorr-client-holder.js';
import type { NarratorrClientPair } from './narratorr-clients.js';
import type { IEbookStreamClient } from './narratorr-stream-client.js';
import type { V1Capabilities } from '../../shared/schemas/v1/capabilities.js';

// The capability resolver (issue #144), driven with an explicit `nowMs` and a stub upstream — no
// fake timers. Every branch is pinned on the OUTCOME the resolver derives (`upstreamStatus`), not
// on the error code string: a Fastify JSON 404 arrives as `HTTP_404` while a reverse-proxy HTML
// 404 page arrives as `NON_JSON`, and both must read as "unsupported".

const T0 = 1_700_000_000_000;

/** A stub upstream whose next answer each test dictates; counts probes so cache hits are visible. */
class StubClient {
  calls = 0;
  private next: () => Promise<V1Capabilities> = async () => ({ companionEpub: { enabled: true } });

  async getCapabilities(): Promise<V1Capabilities> {
    this.calls += 1;
    return this.next();
  }

  /** Answer a parsed capability body. */
  resolves(enabled: boolean): void {
    this.next = async () => ({ companionEpub: { enabled } });
  }

  /** Answer with an upstream failure. */
  rejects(err: unknown): void {
    this.next = () => Promise.reject(err);
  }

  /** Hand back a promise this test settles by hand — the single-flight / in-flight-race lever. */
  defers(): { resolve: (enabled: boolean) => void; reject: (err: unknown) => void } {
    let settle!: { resolve: (enabled: boolean) => void; reject: (err: unknown) => void };
    const pending = new Promise<V1Capabilities>((res, rej) => {
      settle = {
        resolve: (enabled) => res({ companionEpub: { enabled } }),
        reject: rej,
      };
    });
    this.next = () => pending;
    return settle;
  }
}

/**
 * Widen a capability-only stub to a whole connection pair. The holder is the production seam for
 * the NOT_CONFIGURED / live-reconnect cases and it delegates every method; these tests only ever
 * reach `getCapabilities`, so the other members are deliberately absent. The stream half is never
 * called here — it exists because a connection is installed as a PAIR, never a lone client.
 */
const asPair = (stub: ICapabilityClient): NarratorrClientPair => ({
  json: stub as INarratorrClient,
  stream: {} as IEbookStreamClient,
});

const upstream = (status: number, code: string) => new NarratorrError(status, code, `upstream ${code}`);
const NETWORK = upstream(0, 'NETWORK');
const CONTRACT_MISMATCH = upstream(200, 'CONTRACT_MISMATCH');

/**
 * A hand-driven connection generation. The resolver reads `generation` per call and owns none of
 * its own, so a test can retire its cache exactly the way `reconfigure()`'s holder swap does —
 * without standing up clients it never calls. (`NarratorrClientHolder` satisfies this
 * structurally; the holder-driven cases below use the real thing.)
 */
class FakeConnection {
  generation = 0;
  /** What a `holder.set(...)` does to the resolver's view of the world. */
  swap(): void {
    this.generation += 1;
  }
}

/** A stub + resolver pair wired the way production wires them (resolver reads the client live). */
function build(): { client: StubClient; connection: FakeConnection; features: FeatureService } {
  const client = new StubClient();
  const connection = new FakeConnection();
  return { client, connection, features: new FeatureService(client, connection) };
}

describe('FeatureService — outcome classification', () => {
  it('resolves the parsed capability in both directions', async () => {
    const a = build();
    a.client.resolves(true);
    await expect(a.features.ebooksCapability(T0)).resolves.toBe(true);

    const b = build();
    b.client.resolves(false);
    await expect(b.features.ebooksCapability(T0)).resolves.toBe(false);
  });

  it('treats a 404 as definitively unsupported — for BOTH the JSON and the HTML shape', async () => {
    // The load-bearing pair: keying on `upstreamCode` instead of `upstreamStatus` would classify
    // one of these as transient. A reverse proxy's HTML 404 page never parses as an error
    // envelope, so it surfaces as NON_JSON while still carrying status 404.
    for (const err of [upstream(404, 'HTTP_404'), upstream(404, 'NON_JSON')]) {
      const { client, features } = build();
      client.rejects(err);
      await expect(features.ebooksCapability(T0)).resolves.toBe(false);
      // Definitive → cached for the long TTL, so a second call inside 5m does not re-probe.
      await expect(features.ebooksCapability(T0 + 1000)).resolves.toBe(false);
      expect(client.calls).toBe(1);
    }
  });

  it.each([
    ['401 (auth, never "unsupported")', upstream(401, 'HTTP_401')],
    ['403', upstream(403, 'HTTP_403')],
    ['CONTRACT_MISMATCH (provider drift on a 200)', CONTRACT_MISMATCH],
    ['NETWORK (transport error or timeout)', NETWORK],
    ['some other non-2xx', upstream(503, 'HTTP_503')],
    ['a non-NarratorrError escaping the client', new Error('boom')],
  ])('treats %s as transient — never a cached false', async (_label, err) => {
    const { client, features } = build();
    // No prior success → a transient error fails closed immediately…
    client.rejects(err);
    await expect(features.ebooksCapability(T0)).resolves.toBe(false);
    // …and installs NOTHING, so the next call probes again rather than serving a cached false.
    client.resolves(true);
    await expect(features.ebooksCapability(T0 + 1)).resolves.toBe(true);
    expect(client.calls).toBe(2);
  });

  it('resolves NOT_CONFIGURED to false immediately, with no upstream call and no window started', async () => {
    // Through a real unconfigured holder — the exact production path for a fresh install.
    const inner = new StubClient();
    const holder = new NarratorrClientHolder(null);
    const features = new FeatureService(holder, holder);

    await expect(features.ebooksCapability(T0)).resolves.toBe(false);
    expect(inner.calls).toBe(0);

    // A fresh install must not burn the 15-minute budget on a permanent condition: once narratorr
    // IS configured, the first real success behaves exactly like a first success — a later
    // transient failure inside the window still stale-serves it.
    inner.resolves(true);
    holder.set(asPair(inner));
    await expect(features.ebooksCapability(T0 + 1000)).resolves.toBe(true);
    inner.rejects(NETWORK);
    await expect(features.ebooksCapability(T0 + 1000 + CAPABILITY_STALE_WINDOW_MS - 1)).resolves.toBe(true);
  });
});

describe('FeatureService — caching', () => {
  it('serves a successful probe for 60s and re-probes at the exact boundary', async () => {
    const { client, features } = build();
    client.resolves(true);
    await expect(features.ebooksCapability(T0)).resolves.toBe(true);
    await expect(features.ebooksCapability(T0 + CAPABILITY_TTL_MS - 1)).resolves.toBe(true);
    expect(client.calls).toBe(1);

    // EXACTLY at the TTL the entry is stale (`nowMs - resolvedAt < ttl` is false) — the boundary
    // an off-by-one `<=` would get wrong.
    client.resolves(false);
    await expect(features.ebooksCapability(T0 + CAPABILITY_TTL_MS)).resolves.toBe(false);
    expect(client.calls).toBe(2);
  });

  it('serves a 404 for 5m and re-probes at the exact boundary', async () => {
    const { client, features } = build();
    client.rejects(upstream(404, 'HTTP_404'));
    await expect(features.ebooksCapability(T0)).resolves.toBe(false);
    await expect(features.ebooksCapability(T0 + CAPABILITY_UNSUPPORTED_TTL_MS - 1)).resolves.toBe(false);
    expect(client.calls).toBe(1);

    client.resolves(true); // narratorr upgraded
    await expect(features.ebooksCapability(T0 + CAPABILITY_UNSUPPORTED_TTL_MS)).resolves.toBe(true);
    expect(client.calls).toBe(2);
  });

  it('does not confuse the two TTLs: a successful `false` expires in 60s, not 5m', async () => {
    // The TTL is a property of HOW the value was resolved, not of the value. A resolver keying the
    // long TTL off `value === false` would hold this stale for five minutes.
    const { client, features } = build();
    client.resolves(false);
    await expect(features.ebooksCapability(T0)).resolves.toBe(false);
    client.resolves(true);
    await expect(features.ebooksCapability(T0 + CAPABILITY_TTL_MS)).resolves.toBe(true);
    expect(client.calls).toBe(2);
  });
});

describe('FeatureService — stale serve on transient errors', () => {
  it('serves the last known value through repeated transient failures', async () => {
    const { client, features } = build();
    client.resolves(true);
    await expect(features.ebooksCapability(T0)).resolves.toBe(true);

    client.rejects(NETWORK);
    await expect(features.ebooksCapability(T0 + 5 * 60_000)).resolves.toBe(true);
    await expect(features.ebooksCapability(T0 + 10 * 60_000)).resolves.toBe(true);
  });

  it('anchors the window to the last SUCCESS, not the last failure, and fails closed at the boundary', async () => {
    // THE load-bearing case. A naive implementation that resets the window on each failure (or
    // that lets a failure install/advance an entry) would still answer `true` at 15m+.
    const { client, features } = build();
    client.resolves(true);
    await expect(features.ebooksCapability(T0)).resolves.toBe(true);

    client.rejects(NETWORK);
    await expect(features.ebooksCapability(T0 + 5 * 60_000)).resolves.toBe(true);
    await expect(features.ebooksCapability(T0 + 10 * 60_000)).resolves.toBe(true);
    await expect(features.ebooksCapability(T0 + 14 * 60_000)).resolves.toBe(true);
    // Exactly at 15m the window is closed (`< 900_000` is false) — the `<` vs `<=` boundary.
    await expect(features.ebooksCapability(T0 + CAPABILITY_STALE_WINDOW_MS)).resolves.toBe(false);
    await expect(features.ebooksCapability(T0 + CAPABILITY_STALE_WINDOW_MS + 1)).resolves.toBe(false);
  });

  it('fails closed immediately when there is no prior success', async () => {
    const { client, features } = build();
    client.rejects(NETWORK);
    await expect(features.ebooksCapability(T0)).resolves.toBe(false);
  });

  it('re-arms the window on a later success', async () => {
    const { client, features } = build();
    client.resolves(true);
    await expect(features.ebooksCapability(T0)).resolves.toBe(true);
    // A fresh success at T0 + 10m moves the anchor, so a failure at T0 + 20m is still inside.
    await expect(features.ebooksCapability(T0 + 10 * 60_000)).resolves.toBe(true);
    client.rejects(NETWORK);
    await expect(features.ebooksCapability(T0 + 20 * 60_000)).resolves.toBe(true);
  });
});

describe('FeatureService — single flight', () => {
  it('collapses concurrent calls onto one upstream request', async () => {
    const { client, features } = build();
    const settle = client.defers();

    const calls = [features.ebooksCapability(T0), features.ebooksCapability(T0), features.ebooksCapability(T0)];
    settle.resolve(true);

    await expect(Promise.all(calls)).resolves.toEqual([true, true, true]);
    expect(client.calls).toBe(1);
  });

  it('releases the slot after a probe that failed transiently, so a later call probes again', async () => {
    // Pins the RELEASE: drop it and the settled promise stays parked in the slot, so every later
    // caller joins it forever and the resolver never probes again. (The release lives in a
    // `finally` for defence in depth — `probe()` maps every outcome and cannot itself reject, so
    // no test can distinguish the `finally` from a plain post-await release; what IS observable,
    // and asserted here, is that the slot is freed once the probe settles.)
    const { client, features } = build();
    const settle = client.defers();
    const first = features.ebooksCapability(T0);
    settle.reject(NETWORK);
    await expect(first).resolves.toBe(false);

    client.resolves(true);
    await expect(features.ebooksCapability(T0 + 1)).resolves.toBe(true);
    expect(client.calls).toBe(2);
  });
});

// Issue #145: the resolver no longer owns a generation — it reads the CONNECTION's. So every case
// below retires the cache by swapping the connection (the real `holder.set()`, or the equivalent
// counter bump), which is exactly what `reconfigure()` does. Nothing calls an `invalidate()`,
// because there no longer is one to forget.
describe('FeatureService — retirement by connection swap (generation)', () => {
  it('re-probes after a connection swap, even inside both TTLs', async () => {
    for (const seed of [
      (c: StubClient) => c.resolves(true),
      (c: StubClient) => c.rejects(upstream(404, 'HTTP_404')),
    ]) {
      const { client, connection, features } = build();
      seed(client);
      await features.ebooksCapability(T0);
      expect(client.calls).toBe(1);

      connection.swap();
      client.resolves(true);
      await expect(features.ebooksCapability(T0 + 1)).resolves.toBe(true);
      expect(client.calls).toBe(2);
    }
  });

  it('A→B: the first post-swap call starts its OWN probe and A cannot populate the cache', async () => {
    // The connection changed mid-probe. A is still in flight against the OLD server; B is the new
    // one. Installing B and retiring A's generation is ONE statement — the holder swap itself.
    const a = new StubClient();
    const b = new StubClient();
    const holder = new NarratorrClientHolder(asPair(a));
    const features = new FeatureService(holder, holder);
    const settleA = a.defers();
    const first = features.ebooksCapability(T0);

    holder.set(asPair(b));

    // (a) A fresh caller does not join A's flight — it asks B.
    b.resolves(false);
    await expect(features.ebooksCapability(T0 + 1)).resolves.toBe(false);
    expect(b.calls).toBe(1);

    // (b) A's late `true` is returned to ITS waiter but written nowhere.
    settleA.resolve(true);
    await expect(first).resolves.toBe(true);
    b.rejects(NETWORK);
    // Gen 1 has no successful entry of its own yet (B answered `false` — that IS an entry, so
    // expire it first), so once it lapses a transient failure must fail closed, never A's `true`.
    await expect(features.ebooksCapability(T0 + 1 + CAPABILITY_TTL_MS)).resolves.toBe(false);

    // (c) B's answer is what a fresh call inside the TTL serves.
    b.resolves(true);
    const t = T0 + 1 + CAPABILITY_TTL_MS + 1;
    await expect(features.ebooksCapability(t)).resolves.toBe(true);
    await expect(features.ebooksCapability(t + 1)).resolves.toBe(true);
  });

  it('A→unconfigured: the next resolve answers NOT_CONFIGURED with no upstream call', async () => {
    const a = new StubClient();
    const holder = new NarratorrClientHolder(asPair(a));
    const features = new FeatureService(holder, holder);
    const settleA = a.defers();
    const first = features.ebooksCapability(T0);

    holder.set(null);

    await expect(features.ebooksCapability(T0 + 1)).resolves.toBe(false);
    expect(a.calls).toBe(1); // only the in-flight probe; the unconfigured read made none

    settleA.resolve(true);
    await expect(first).resolves.toBe(true);
    // A's completion neither cached nor changed anything for the new (unconfigured) generation.
    await expect(features.ebooksCapability(T0 + 2)).resolves.toBe(false);
  });

  it('identity-checks the in-flight release: settling the OLD flight cannot cancel the new one', async () => {
    const { client, connection, features } = build();
    const settleOld = client.defers();
    const old = features.ebooksCapability(T0);

    connection.swap();
    const settleNew = client.defers();
    const first = features.ebooksCapability(T0 + 1);

    // The old flight settles now — a release without the identity check would null the slot the
    // NEW flight owns, and the two callers below would each start their own probe.
    settleOld.resolve(true);
    await expect(old).resolves.toBe(true);

    const joiners = [features.ebooksCapability(T0 + 2), features.ebooksCapability(T0 + 3)];
    settleNew.resolve(false);
    await expect(Promise.all([first, ...joiners])).resolves.toEqual([false, false, false]);
    expect(client.calls).toBe(2); // one per generation, not four
  });

  it('a new generation inherits no stale budget — the first transient failure fails closed', async () => {
    // The load-bearing case for "a swap bumps, it does not clear": an implementation that still
    // reads the previous generation's entry answers `true` here.
    const { client, connection, features } = build();
    client.resolves(true);
    await expect(features.ebooksCapability(T0)).resolves.toBe(true);

    connection.swap();
    client.rejects(NETWORK);
    await expect(features.ebooksCapability(T0 + 2000)).resolves.toBe(false);
  });

  it('a superseded probe that FAILS does not consume the new generation window', async () => {
    const { client, connection, features } = build();
    const settleOld = client.defers();
    const old = features.ebooksCapability(T0);

    connection.swap();
    settleOld.reject(NETWORK);
    await expect(old).resolves.toBe(false);

    // The new generation is untouched: a success then stale-serves normally through a failure.
    client.resolves(true);
    await expect(features.ebooksCapability(T0 + 1)).resolves.toBe(true);
    client.rejects(NETWORK);
    await expect(features.ebooksCapability(T0 + 1 + CAPABILITY_STALE_WINDOW_MS - 1)).resolves.toBe(true);
  });

  it('an old waiter keeps its OWN generation stale context, and its outcome is not written back', async () => {
    // Success at T0 (gen 0, lastSuccessAt = T0). At the TTL boundary a refresh starts against A;
    // while A is pending the connection changes (gen 1); then A fails transiently.
    const { client, connection, features } = build();
    client.resolves(true);
    await expect(features.ebooksCapability(T0)).resolves.toBe(true);

    const settleA = client.defers();
    const refreshAt = T0 + CAPABILITY_TTL_MS;
    const waiter = features.ebooksCapability(refreshAt);

    connection.swap();
    settleA.reject(NETWORK);

    // (a) The waiter asked about the OLD connection, whose 15-minute window was still open at
    // `refreshAt` — so it gets gen 0's `true`. Reading shared state after the catch yields false.
    await expect(waiter).resolves.toBe(true);

    // (b) …and nothing about that was written back: gen 1 starts with no entry and no budget.
    client.rejects(NETWORK);
    await expect(features.ebooksCapability(refreshAt + 1)).resolves.toBe(false);
  });

  it('without a connection swap, a settled result survives unrelated activity', async () => {
    // The resolver-level half of "a non-narratorr settings save preserves capability state":
    // only a swap retires an entry, so nothing else can cost a probe.
    const { client, features } = build();
    client.resolves(true);
    await expect(features.ebooksCapability(T0)).resolves.toBe(true);
    await expect(features.ebooksCapability(T0 + 30_000)).resolves.toBe(true);
    expect(client.calls).toBe(1);
  });
});
