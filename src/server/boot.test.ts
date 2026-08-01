import { describe, it, expect, vi } from 'vitest';
import { startServing } from './boot.js';

// `src/server/index.ts` runs `main()` on import, so a wiring line left there is one no receipt can
// protect. This seam exists for an ORDERING guarantee: the Kindle-send boot sweep converges
// `started` reservations a previous process left behind, and a GLOBAL sweep is only safe because
// nothing is in flight yet — running it once traffic is being served could converge a live owner's
// row out from under it.

describe('startServing', () => {
  it('awaits the Kindle lease sweep BEFORE the server starts listening', async () => {
    const order: string[] = [];
    let releaseSweep = (): void => {};
    const sweeping = new Promise<void>((resolve) => {
      releaseSweep = resolve;
    });

    const listen = vi.fn(async () => {
      order.push('listen');
    });
    const running = startServing({
      sweepKindleLeases: async () => {
        order.push('sweep:start');
        await sweeping;
        order.push('sweep:done');
      },
      listen,
    });

    // While the sweep is still pending, nothing may accept traffic.
    await Promise.resolve();
    expect(listen).not.toHaveBeenCalled();

    releaseSweep();
    await running;
    expect(order).toEqual(['sweep:start', 'sweep:done', 'listen']);
  });

  it('propagates a failing sweep instead of serving traffic on unconverged state', async () => {
    const listen = vi.fn(async () => undefined);
    await expect(
      startServing({
        sweepKindleLeases: () => Promise.reject(new Error('sweep failed')),
        listen,
      }),
    ).rejects.toThrow('sweep failed');
    expect(listen).not.toHaveBeenCalled();
  });
});
