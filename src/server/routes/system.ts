import os from 'node:os';
import { stat } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { AppDeps } from '../services/deps.js';
import { systemInfoSchema, type SystemInfoDto } from '../../shared/schemas/system.js';
import { NarratorrError } from '../services/narratorr-client.js';
import type { NarratorrClientHolder } from '../services/narratorr-client-holder.js';
import { requireAdmin } from '../plugins/auth.js';
import { APP_VERSION, APP_BUILT_AT } from '../version.js';

/**
 * Size of the libSQL DB file, or `null` on ANY failure or non-regular-file path —
 * ENOENT/EACCES/ENOTDIR, a directory, or the `:memory:` sentinel. Never throws, so a
 * stat hiccup degrades the field rather than 500'ing the whole card.
 */
async function databaseSize(path: string): Promise<number | null> {
  if (!path || path === ':memory:') return null;
  try {
    const st = await stat(path);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

/**
 * Probe the connected narratorr's build info, mapping every outcome to a `narratorr`
 * state instead of letting it reach the global error handler as a 5xx:
 * - success                     → `connected` (+ version, optional commit)
 * - NOT_CONFIGURED (holder)     → `not_configured` (no upstream call was made)
 * - CONTRACT_MISMATCH           → `unavailable` (reachable, bad body)
 * - NETWORK / non-2xx upstream  → `unreachable`
 * - anything else               → `unavailable`
 */
async function narratorrSystem(holder: NarratorrClientHolder): Promise<SystemInfoDto['narratorr']> {
  try {
    const sys = await holder.getSystem();
    return {
      state: 'connected',
      version: sys.version,
      ...(sys.commit !== undefined && { commit: sys.commit }),
    };
  } catch (err: unknown) {
    if (err instanceof NarratorrError) {
      if (err.upstreamCode === 'NOT_CONFIGURED') return { state: 'not_configured' };
      if (err.upstreamCode === 'CONTRACT_MISMATCH') return { state: 'unavailable' };
      // NETWORK (transport/timeout) and any non-2xx upstream → unreachable.
      return { state: 'unreachable' };
    }
    return { state: 'unavailable' };
  }
}

/**
 * Admin-only System Information card backend. Read-only server/environment details plus
 * the connected narratorr's version + reachability. Deliberately separate from the PUBLIC
 * `/api/health` (which must not leak version/OS/db-size to anon callers). Always returns
 * 200 in the narratorr-failure cases — the failure degrades to a `narratorr.state`.
 */
export function registerSystemRoutes(app: FastifyInstance, deps: AppDeps): void {
  const a = app.withTypeProvider<ZodTypeProvider>();

  a.get(
    '/api/admin/system',
    { schema: { response: { 200: systemInfoSchema } } },
    async (request): Promise<SystemInfoDto> => {
      requireAdmin(request);
      return {
        version: APP_VERSION,
        builtAt: APP_BUILT_AT,
        node: process.version,
        os: `${os.type()} ${os.release()}`,
        databaseSizeBytes: await databaseSize(deps.config.databasePath),
        narratorr: await narratorrSystem(deps.narratorr),
      };
    },
  );
}
