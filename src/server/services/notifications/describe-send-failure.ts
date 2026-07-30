import { redact } from './redact.js';

/**
 * Map a failed notifier `send()` to the message the ADMIN sees in the Settings Test result.
 *
 * The problem this solves: `redact()` returns the runtime's own text, so a dead host, a bad
 * DNS name, a TLS failure and a destination that legitimately answers a redirect all render
 * as `fetch failed` on Node 24 — nothing an admin can act on. Since #199 every adapter sets
 * `redirect: 'error'`, so the redirect case is easy to hit: an `http://` base behind a proxy
 * that 301s to `https://` now fails, and the remedy (paste the final URL) was nowhere in the UI.
 *
 * This is COPY, not a taxonomy. Two classes get a static sentence; everything else keeps
 * today's `redact()` behavior — adapter-constructed messages (`ntfy responded 500`) and
 * nodemailer/SMTP errors (which carry their own specific text plus an `ECONNREFUSED`-class
 * `code`) are already actionable and must not be flattened into "could not reach".
 *
 * Classification is STRUCTURAL — by type and by the `name` property, never by message text.
 * Measured on this repo's Node (v24.18.0), connection-refused, DNS `ENOTFOUND`, a TLS failure
 * and a `redirect: 'error'` rejection ALL reject as `TypeError` with message `"fetch failed"`,
 * and a fired `AbortSignal.timeout(10_000)` rejects as a `DOMException` whose `name` is
 * `TimeoutError`. fetch specifies the type and says nothing about the message, and this repo
 * floats on `node:24-slim`, so `"fetch failed"` / `cause: "unexpected redirect"` can change on
 * any supported upgrade — see the `fetch-redirect-error-invariant` learning. Matching either
 * would be a latent break, and probing `err.cause` is the same class of undici-internal detail.
 *
 * Both mapped strings are STATIC: they interpolate no error, cause, URL, host or config value.
 * That is what makes the mapped path leak-proof by construction — the capability-URL notifiers
 * (webhook/Discord/Slack) and Telegram carry their secret IN THE URL, which is exactly what a
 * raw network message embeds.
 *
 * Residual, accepted: a genuine programming `TypeError` escaping an adapter's `send()` (a bug)
 * reports as "could not reach the destination". All seven fetch adapters construct their own
 * non-network failures as plain `Error`s, so a `TypeError` at that boundary is a network error
 * in practice — and the dispatcher log still carries the real (scrubbed) text either way.
 *
 * Only the ADMIN-FACING Test envelope is remapped. `notifier.service.ts` and the request-path
 * notification sinks keep logging `redact(err, …)`: an operator debugging a failure needs the
 * raw detail, and a server log is not the sink this issue is about.
 */

/** Redirect and unreachable-host both reject identically, so name both in one sentence. */
const UNREACHABLE = 'Could not reach the destination — check the URL, including whether it redirects.';
const TIMEOUT = 'The destination did not respond in time.';

/** `name` off any object, without asserting a shape onto an unknown throw value. */
function nameOf(err: unknown): unknown {
  return typeof err === 'object' && err !== null && 'name' in err ? err.name : undefined;
}

export function describeSendFailure(err: unknown, secrets: Iterable<string> = []): string {
  // Ordered ahead of nothing that could shadow it, but note a `DOMException` IS an `Error`
  // in Node — a broader `instanceof Error` branch here would swallow the timeout case.
  if (err instanceof TypeError) return UNREACHABLE;
  if (nameOf(err) === 'TimeoutError') return TIMEOUT;
  return redact(err, secrets);
}
