import { connect } from 'node:net';
import { describe, it, expect } from 'vitest';
import { startIntegrationScenario } from './integration-harness.js';
import type { FakeNarratorr } from './fake-narratorr.js';
import type { FakeSmtp } from './fake-smtp.js';

// The integration harness starts THREE listeners (fake narratorr, fake SMTP, the app itself), and
// AC7 says none of them may outlive a scenario. Every scenario file exercises the SUCCESS path, so
// the failure path — a construction step that rejects after the fakes are already up — would
// otherwise have no receipt at all: deleting the unwind would leave the whole suite green while a
// setup regression leaked two listeners and hung the Vitest worker.
//
// The teardown claim is asserted at the SOCKET, not by counting `close()` calls: a spy would pass
// against a `close()` that resolved without actually releasing the port.

/** Can anything still accept a connection on this port? */
function isListening(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

const portOf = (baseUrl: string): number => Number(new URL(baseUrl).port);

describe('a partially constructed scenario unwinds every listener it started (AC7)', () => {
  it('closes BOTH fakes and rethrows the ORIGINAL error when construction fails after they listen', async () => {
    const boom = new Error('construction failed after both fakes were listening');
    // An array, not a `let`: TypeScript does not narrow a variable assigned inside a callback, and
    // the fakes have to be readable AFTER the rejection.
    const seen: Array<{ upstream: FakeNarratorr; smtp: FakeSmtp }> = [];

    await expect(
      startIntegrationScenario({
        onFakesListening: (fakes) => {
          seen.push(fakes);
          throw boom;
        },
      }),
      // IDENTITY, not just "it threw": the unwind must never mask the construction failure with an
      // error of its own.
    ).rejects.toBe(boom);

    expect(seen).toHaveLength(1);
    const { upstream, smtp } = seen[0]!;
    // Nothing else could have closed these. The scenario object never became reachable, so no
    // `afterEach` had anything to call — if the unwind were removed, both would still be listening.
    expect(await isListening(portOf(upstream.baseUrl))).toBe(false);
    expect(await isListening(smtp.port)).toBe(false);
  }, 30_000);

  it('DISCRIMINATES: the same probe sees a healthy scenario listening, then closed by teardown', async () => {
    // The control. Without it, a probe that always answered `false` (wrong port, wrong host, a
    // rejected connect for any reason) would satisfy the assertions above while proving nothing.
    // It doubles as the success-path half of AC7: `close()` genuinely releases all three ports.
    const s = await startIntegrationScenario();
    const narratorrPort = portOf(s.upstream.baseUrl);
    const appPort = portOf(s.baseUrl);
    try {
      expect(await isListening(narratorrPort)).toBe(true);
      expect(await isListening(s.smtp.port)).toBe(true);
      expect(await isListening(appPort)).toBe(true);
    } finally {
      await s.close();
    }

    expect(await isListening(narratorrPort)).toBe(false);
    expect(await isListening(s.smtp.port)).toBe(false);
    expect(await isListening(appPort)).toBe(false);
  }, 30_000);
});
