/**
 * The boot steps that must complete BEFORE the server accepts traffic, as a seam.
 *
 * `src/server/index.ts` runs `main()` on import, so a wiring line left there is one no receipt can
 * protect — the same reason `registerClientSurface` was extracted (issue #146). This one exists for
 * an ORDERING guarantee rather than a registration one: the Kindle-send lease sweep converges
 * `started` reservations a previous process left behind, and it is only safe BECAUSE nothing is in
 * flight yet. Running it once traffic is being served would let a global sweep converge a live
 * owner's row out from under it.
 */
export interface PreListenBoot {
  /** Converge over-lease `kindle_sends` reservations left behind by a previous process. */
  sweepKindleLeases(): Promise<void>;
  /** Start accepting requests. */
  listen(): Promise<unknown>;
}

/** Sweep, THEN listen — awaited in that order, so no request can race the sweep. */
export async function startServing(boot: PreListenBoot): Promise<void> {
  await boot.sweepKindleLeases();
  await boot.listen();
}
