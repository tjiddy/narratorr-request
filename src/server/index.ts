import path from 'node:path';
import { existsSync } from 'node:fs';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { config, APP_ROOT } from './config.js';
import { runMigrations } from '../db/migrate.js';
import { createDb } from '../db/client.js';
import { UserService } from './services/user.service.js';
import { SettingsService } from './services/settings.service.js';
import { RequestService, resolveRequestPolicy, sanitizeAutoApproveRoles } from './services/request.service.js';
import { SearchService } from './services/search.service.js';
import { StatusPoller } from './services/status-poller.js';
import { buildNarratorrConnection } from './services/narratorr-clients.js';
import { OidcService, makeOidcMapper, type OidcProfile } from './services/oidc.service.js';
import { buildNotifier } from './services/notifications/index.js';
import { RequesterEmailService } from './services/notifications/requester-email.js';
import { ConnectorSettingsService } from './services/connector-settings.service.js';
import { SecretCodec, deriveSettingsKey } from './util/secret-codec.js';
import { errorHandlerPlugin } from './plugins/error-handler.js';
import { authRateLimitOptions } from './plugins/rate-limit.js';
import { authPlugin } from './plugins/auth.js';
import { buildHelmetOptions } from './plugins/helmet-options.js';
import { registerRoutes } from './routes/index.js';
import { errorBody } from '../shared/schemas/v1/common.js';
import type { AppDeps } from './services/deps.js';
import './types.js';

async function main(): Promise<void> {
  await runMigrations(config.databasePath);
  const db = createDb(config.databasePath);

  const users = new UserService(db, { bootstrapAdmin: config.bootstrapAdmin });
  const settings = new SettingsService(db);
  const settingsRow = await settings.ensure();

  // App (and its logger) first, so the connector service can WARN through it when a
  // stored secret can't be decrypted.
  const app = Fastify({
    logger: { level: config.isDev ? 'info' : 'warn' },
    // Behind a reverse proxy, trust X-Forwarded-* so request.ip is the real client (used
    // for auth rate-limit keying). Off by default; configured via TRUSTED_PROXIES.
    trustProxy: config.trustProxy,
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Connector config (narratorr connection + notification channels) lives in the DB,
  // edited in the Settings UI — secrets encrypted with a key derived from SETTINGS_KEY
  // (or SESSION_SECRET). A fresh install boots with narratorr unconfigured; the holder
  // makes calls fail cleanly until the admin sets it, and saving rebuilds it live.
  const codec = new SecretCodec(deriveSettingsKey({ settingsKey: config.settingsKey, sessionSecret: config.sessionSecret }));
  const connectorSettings = new ConnectorSettingsService(db, codec, app.log);
  // One seam builds the whole graph — the client pair, the holder that owns it, and the capability
  // resolver keyed to that holder's generation. `main()` runs on import, so this file can't be
  // executed by a test; the seam is what makes those wiring invariants assertable.
  const { narratorr, features } = buildNarratorrConnection(await connectorSettings.getNarratorrConfig());
  // Surface the unconfigured state at WARN so it survives the prod log level (info is
  // filtered in production) — the on-call breadcrumb for "search/requests don't work".
  if (!narratorr.configured) {
    app.log.warn('narratorr is not configured — search and requests will fail until it is set on the Settings page');
  }

  // Seed the request policy from the SANITIZED quota (not the raw settingsRow columns) via the
  // shared resolveRequestPolicy seam, so boot enforcement and the Settings GET agree on the same
  // narrowed values — a legacy/corrupt out-of-set window or non-positive limit degrades identically
  // on both paths. The seam is unit-tested (connector-settings.service.test.ts) so a regression to
  // the raw row fails a test rather than silently re-diverging.
  // Requester-facing `available` email (issue #50). Reads the LIVE decrypted notifier config at
  // send time (accessor, not captured) so it selects the current first-usable email notifier as
  // its SMTP source after any Settings save. Never routes through the admin notifier/EmailChannel.
  const requesterEmail = new RequesterEmailService(() => connectorSettings.getNotificationsConfig());
  const requests = new RequestService(
    db,
    narratorr,
    await resolveRequestPolicy(connectorSettings, sanitizeAutoApproveRoles(settingsRow.autoApproveRoles, app.log)),
    // Live-notifier accessor (NOT a captured instance): the settings route reassigns
    // deps.notifier on every notifier-config save, so read it at dispatch time. The app
    // logger makes a lost request.failed (rejected lookup/dispatch) diagnosable. `requesterEmail`
    // adds the issue #50 available email — fire-and-forget, email-only, requester-scoped.
    { getNotifier: () => deps.notifier, users, requesterEmail, logger: app.log },
  );
  const search = new SearchService(narratorr);
  // One OidcService per configured provider, keyed by id. Authorization is the approval
  // queue (no per-provider gate), so the mapped profile flows straight to upsertFromOidc.
  const oidc = new Map<string, { service: OidcService<OidcProfile>; config: (typeof config.oidcProviders)[number] }>();
  for (const p of config.oidcProviders) {
    const service = new OidcService<OidcProfile>(
      { issuer: p.issuer, clientId: p.clientId, clientSecret: p.clientSecret, redirectUri: p.redirectUri, scope: p.scope, label: p.label },
      makeOidcMapper(p.label, { subjectClaim: p.subjectClaim, usernameClaim: p.usernameClaim, emailClaim: p.emailClaim }),
    );
    oidc.set(p.id, { service, config: p });
  }

  if (config.authMode === 'bypass') await users.ensureDevAdmin();

  const notifier = buildNotifier(await connectorSettings.getNotificationsConfig(), app.log);
  const deps: AppDeps = {
    config,
    db,
    users,
    settings,
    requests,
    search,
    connectorSettings,
    narratorr,
    features,
    notifier,
    oidc,
  };

  // Serve the built SPA whenever a client build is present — the prod image, a bare
  // `pnpm start`, or the standalone container. Under `pnpm dev` there's no build here
  // and Vite serves the client instead.
  const clientDir = path.join(APP_ROOT, 'dist', 'client');
  const serveClient = existsSync(path.join(clientDir, 'index.html'));

  // Browser hardening when we serve the SPA (CSP, frame-ancestors, referrer policy).
  // Skipped under Vite dev so HMR/inline scripts aren't blocked. The TLS-assuming headers
  // (CSP `upgrade-insecure-requests` + HSTS) are gated on `behindTls` so a plain-HTTP deploy
  // doesn't blank-screen on `ERR_SSL_PROTOCOL_ERROR` — see buildHelmetOptions.
  if (serveClient) {
    await app.register(helmet, buildHelmetOptions({ behindTls: config.behindTls }));
  }

  await app.register(cors, { origin: config.corsOrigin, credentials: true });
  await app.register(cookie, { secret: config.sessionSecret });
  await app.register(rateLimit, authRateLimitOptions);
  await app.register(errorHandlerPlugin);
  await app.register(authPlugin, deps);

  registerRoutes(app, deps);

  if (serveClient) {
    await app.register(fastifyStatic, { root: clientDir, wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/')) {
        return reply.sendFile('index.html');
      }
      return reply.status(404).send(errorBody('NOT_FOUND', `Route ${request.method} ${request.url} not found`));
    });
  } else {
    app.setNotFoundHandler((request, reply) =>
      reply.status(404).send(errorBody('NOT_FOUND', `Route ${request.method} ${request.url} not found`)),
    );
  }

  await app.listen({ port: config.port, host: config.bindHost });
  app.log.info(
    `narratorr-requests on :${config.port} (auth=${config.authMode}, narratorr=${narratorr.configured ? 'configured' : 'unconfigured'})`,
  );

  // Reconcile in-flight acquisitions against narratorr. No-op while narratorr is
  // unconfigured (nothing reaches `acquiring`); the client holder is read live, so it
  // starts working the moment the connection is saved.
  const poller = new StatusPoller({
    requests,
    client: narratorr,
    logger: app.log,
    intervalSeconds: 20,
  });
  poller.start();

  const shutdown = () => {
    poller.stop();
    // Fire-and-forget: we're exiting regardless of how close() settles.
    void app.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
