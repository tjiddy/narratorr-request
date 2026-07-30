import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AppDeps } from '../services/deps.js';
import {
  connectorSettingsDtoSchema,
  notifierDtoSchema,
  updateConnectorSettingsBodySchema,
  createNotifierBodySchema,
  updateNotifierBodySchema,
  notifierTestBodySchema,
  testConnectorBodySchema,
  testConnectorResultSchema,
} from '../../shared/schemas/connectors.js';
import type { TestConnectorResult } from '../../shared/schemas/connectors.js';
import { requireAdmin } from '../plugins/auth.js';
import { NarratorrClient, NarratorrError } from '../services/narratorr-client.js';
import { buildNarratorrClients } from '../services/narratorr-clients.js';
import { Mutex } from '../util/mutex.js';
import {
  buildNotifier,
  buildNotifierChannel,
  render,
  redact,
  describeSendFailure,
  type NotificationEvent,
  type NotificationPayload,
  type SendContext,
} from '../services/notifications/index.js';
import { NOTIFIER_REGISTRY, type NotifierType } from '../../shared/notifier-registry.js';

function describeNarratorrError(err: unknown): string {
  if (err instanceof NarratorrError) {
    // Same admin-facing gap as the notifier Test (#207): NarratorrClient folds a `redirect:
    // 'error'` rejection (#171) into this same status-0 NETWORK branch, so an `http://` base
    // behind a proxy that 301s lands here indistinguishable from a dead host. Name both.
    if (err.upstreamStatus === 0) return 'Could not reach narratorr — check the URL, including whether it redirects.';
    if (err.upstreamStatus === 401 || err.upstreamStatus === 403) return 'Authentication failed — check the API key.';
    return `narratorr responded ${err.upstreamStatus}.`;
  }
  return err instanceof Error ? err.message : 'Unknown error';
}

/** The sample payload for an event — so Test exercises the event the notifier is configured for. */
function samplePayload(event: NotificationEvent): NotificationPayload {
  switch (event) {
    case 'request.created':
      return {
        event: 'request.created',
        request: { publicId: 'rq_test', title: 'Test notification', author: 'narratorr-requests', asin: 'TEST', coverUrl: null },
        requester: { username: '(settings test)' },
      };
    case 'request.failed':
      return {
        event: 'request.failed',
        request: { publicId: 'rq_test', title: 'Test notification', author: 'narratorr-requests', asin: 'TEST', coverUrl: null },
        requester: { username: '(settings test)' },
        reason: 'This is a test failure reason.',
      };
    case 'user.pending':
      return {
        event: 'user.pending',
        user: { publicId: 'us_test', username: '(settings test)', email: null, authProvider: 'local' },
      };
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

/** A sample event rendered with the given public URL, for a Test probe. */
function testContext(event: NotificationEvent, publicUrl: string | null): SendContext {
  const payload = samplePayload(event);
  // Render via the real renderer so a test notification matches production formatting.
  return { payload, message: render(payload, publicUrl) };
}

/**
 * The resolved (plaintext) secret values in a candidate notifier config — passed to
 * describeSendFailure() (and through it to redact()) so a Test error embedding a
 * token/key/capability-URL never reaches the admin raw on the fallback path. Walks the
 * registry's secret metadata, so it covers every type without a per-type branch.
 */
function candidateSecrets(candidate: { type: NotifierType; config: Record<string, unknown> }): string[] {
  return NOTIFIER_REGISTRY[candidate.type].secretFields
    .map((sf) => candidate.config[sf.field])
    .filter((v): v is string => typeof v === 'string' && v.length > 0);
}

const idParams = z.object({ id: z.string().min(1) });
const okSchema = z.object({ ok: z.literal(true) });

export function registerSettingsRoutes(app: FastifyInstance, deps: AppDeps): void {
  const a = app.withTypeProvider<ZodTypeProvider>();

  // ONE in-process mutex serializes ALL connector/notifier writes. The critical section
  // wraps the whole read-modify-write + reconfigure(), and covers BOTH the notifier
  // mutations and the /connectors PUT — they share the single app_settings.connectors
  // JSON blob, so an unserialized overlap would lose a change. (Multi-process would need
  // DB-level locking instead — see Mutex.)
  const writeLock = new Mutex();

  // Rebuild the live narratorr connection + notifier from the freshly-saved DB settings, and
  // refresh the request-quota policy so an edited default limit/window takes effect on the
  // next request (no restart). Notifier-only saves re-apply the same quota — a cheap no-op read.
  //
  // `narratorrChanged` (issues #144/#145) gates the CONNECTION SWAP, which is also what retires
  // the cached companion-ebook capability (the holder's generation is the resolver's cache key,
  // so the swap IS the invalidation — there is no separate call to forget). Three things about
  // that statement are load-bearing:
  //   • It is ONE synchronous step: both inner clients and the generation move together, with no
  //     `await` in between. `/api/features` reads deliberately do NOT take `writeLock` (a
  //     capability read must not block on a settings save), so anything less would leave a real
  //     window in which a concurrent read sees the NEW connection paired with the OLD
  //     generation's cache entry. Run-to-completion closes that window by construction — it is
  //     what substitutes for a shared lock here.
  //   • It runs BEFORE the fallible tail. If either later read rejects, the PUT 500s — but the DB
  //     update has already committed, so a swap placed after the tail would be skipped and strand
  //     the saved connection behind the previous one's clients and cache.
  //   • It is CONDITIONAL. A save that cannot change the connection must not rebuild it:
  //     re-installing an identical client would bump the generation and discard a valid
  //     capability result and its 15-minute stale budget on every notifier save, quota edit,
  //     public-URL edit, Kindle-sender selection and ebook-toggle save.
  async function reconfigure(narratorrChanged = false): Promise<void> {
    if (narratorrChanged) {
      // ONE config read feeds BOTH clients through the shared factory, so the JSON and stream
      // halves can never end up built from different credentials.
      const ncfg = await deps.connectorSettings.getNarratorrConfig();
      deps.narratorr.set(ncfg ? buildNarratorrClients({ baseUrl: ncfg.url, apiKey: ncfg.apiKey }) : null);
    }
    deps.notifier = buildNotifier(await deps.connectorSettings.getNotificationsConfig(), app.log);
    deps.requests.reconfigureQuota(await deps.connectorSettings.getDefaultQuota());
  }

  a.get(
    '/api/admin/settings/connectors',
    { schema: { response: { 200: connectorSettingsDtoSchema } } },
    async (request) => {
      requireAdmin(request);
      return deps.connectorSettings.getDto();
    },
  );

  a.put(
    '/api/admin/settings/connectors',
    { schema: { body: updateConnectorSettingsBodySchema, response: { 200: connectorSettingsDtoSchema } } },
    async (request) => {
      requireAdmin(request);
      return writeLock.run(async () => {
        await deps.connectorSettings.update(request.body);
        // `body.narratorr !== undefined` is exhaustive: it is the only input that can change the
        // stored connection (`ConnectorSettingsService.update()` assigns `next.narratorr` solely
        // under that condition). Re-saving the card with unchanged values does swap — one
        // redundant probe, accepted over a before/after config comparison.
        await reconfigure(request.body.narratorr !== undefined);
        return deps.connectorSettings.getDto();
      });
    },
  );

  // ---- Notifier CRUD (per-notifier; all admin, all through the write mutex) ----
  a.post(
    '/api/admin/settings/notifiers',
    { schema: { body: createNotifierBodySchema, response: { 200: notifierDtoSchema } } },
    async (request) => {
      requireAdmin(request);
      return writeLock.run(async () => {
        const created = await deps.connectorSettings.createNotifier(request.body);
        await reconfigure();
        // Return the freshly-created notifier from the masked DTO list (no secret leak),
        // matched by its assigned id — not by array position, which is brittle against any
        // future reorder/filter in getDto() (the update route already returns by id).
        const dto = await deps.connectorSettings.getDto();
        return dto.notifiers.find((n) => n.id === created.id)!;
      });
    },
  );

  a.put(
    '/api/admin/settings/notifiers/:id',
    { schema: { params: idParams, body: updateNotifierBodySchema, response: { 200: notifierDtoSchema } } },
    async (request) => {
      requireAdmin(request);
      const { id } = request.params;
      return writeLock.run(async () => {
        await deps.connectorSettings.updateNotifier(id, request.body);
        await reconfigure();
        const dto = await deps.connectorSettings.getDto();
        return dto.notifiers.find((n) => n.id === id)!;
      });
    },
  );

  a.delete(
    '/api/admin/settings/notifiers/:id',
    { schema: { params: idParams, response: { 200: okSchema } } },
    async (request) => {
      requireAdmin(request);
      const { id } = request.params;
      return writeLock.run(async () => {
        await deps.connectorSettings.deleteNotifier(id);
        await reconfigure();
        return { ok: true as const };
      });
    },
  );

  // Fire a sample notification through the CANDIDATE (current, unsaved) notifier values —
  // so Test confirms config BEFORE a save. Edit (id present) → unchanged secrets fall back
  // to the stored value; the path NEVER persists. Always 200 { success, message } — a
  // failed probe is a result, not an HTTP error. The write mutex is held ONLY around
  // candidate-config building (it resolves omit-to-keep secrets from the stored row); the
  // outbound send() runs OUTSIDE the lock so a slow/dead endpoint can't block Save/Delete/Create.
  a.post(
    '/api/admin/settings/notifiers/test',
    { schema: { body: notifierTestBodySchema, response: { 200: testConnectorResultSchema } } },
    async (request): Promise<TestConnectorResult> => {
      requireAdmin(request);
      const body = request.body;
      let channel;
      let candidate;
      try {
        // Secret resolution reads stored state → serialize it. Channel construction reads no
        // DB state, so building it here (still inside the try) needs no lock.
        candidate = await writeLock.run(() => deps.connectorSettings.buildCandidateNotifier(body));
        channel = buildNotifierChannel(candidate.type, candidate.config);
      } catch (err: unknown) {
        // A bad candidate (e.g. a required secret that won't resolve) is a failed test. No
        // resolved candidate config to enumerate here → pattern-based redaction only.
        return { success: false, message: redact(err) };
      }
      if (!channel) return { success: false, message: `${body.type} is not configured.` };
      try {
        await channel.send(testContext(body.event, body.publicUrl ?? null));
        return { success: true, message: 'Test notification sent.' };
      } catch (err: unknown) {
        // The network class (a fetch rejection / a fired timeout) maps to static, actionable
        // copy — the raw runtime text says `fetch failed` for a dead host, a bad DNS name, a
        // TLS failure AND a destination that answers a redirect alike (#207). Everything else
        // still goes through redact(), which scrubs the resolved candidate secrets by value and
        // URL-embedded secrets (capability webhooks, the Telegram token) by pattern.
        return { success: false, message: describeSendFailure(err, candidateSecrets(candidate)) };
      }
    },
  );

  // Test the narratorr connection (its own card; the /connectors PUT persists it). Probes
  // the candidate (unsaved) discrete fields, omit-to-keep apiKey. Always 200. The write mutex
  // wraps ONLY the candidate-config build (resolves the stored apiKey); the ping() runs OUTSIDE
  // the lock so a slow/dead narratorr can't block a concurrent Save/Delete/Create write.
  a.post(
    '/api/admin/settings/connectors/test',
    { schema: { body: testConnectorBodySchema, response: { 200: testConnectorResultSchema } } },
    async (request): Promise<TestConnectorResult> => {
      requireAdmin(request);
      const body = request.body;
      const cfg = await writeLock.run(() => deps.connectorSettings.buildCandidateNarratorrConfig(body.narratorr));
      if (!cfg) return { success: false, message: 'Narratorr is not configured.' };
      try {
        await new NarratorrClient({ baseUrl: cfg.url, apiKey: cfg.apiKey }).ping();
        return { success: true, message: 'Connected to narratorr.' };
      } catch (err: unknown) {
        return { success: false, message: describeNarratorrError(err) };
      }
    },
  );
}
