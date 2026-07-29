import Fastify, { type FastifyInstance } from 'fastify';
import { expect } from 'vitest';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { createTestDb } from './db.js';
import { UserService } from '../services/user.service.js';
import { SettingsService } from '../services/settings.service.js';
import { ConnectorSettingsService } from '../services/connector-settings.service.js';
import { RequestService, resolveRequestPolicy, sanitizeAutoApproveRoles } from '../services/request.service.js';
import { SearchService } from '../services/search.service.js';
import { CompanionEbookService } from '../services/companion-ebook.service.js';
import { KindleSendService } from '../services/kindle-send.service.js';
import { buildKindleTransport } from '../services/kindle-send.transport.js';
import { buildNarratorrConnection } from '../services/narratorr-clients.js';
import { buildNotifier } from '../services/notifications/index.js';
import { RequesterEmailService } from '../services/notifications/requester-email.js';
import { SecretCodec, deriveSettingsKey } from '../util/secret-codec.js';
import { errorHandlerPlugin } from '../plugins/error-handler.js';
import { authRateLimitOptions } from '../plugins/rate-limit.js';
import { authPlugin, SESSION_COOKIE } from '../plugins/auth.js';
import { registerRoutes } from '../routes/index.js';
import { registerNotFoundHandler } from '../routes/not-found.js';
import { createSessionToken } from '../util/session.js';
import { insertUser } from './db.js';
import { startFakeNarratorr, type FakeNarratorr } from './fake-narratorr.js';
import { startFakeSmtp, type FakeSmtp } from './fake-smtp.js';
import { NARRATORR_API_KEY, expectNoLeaksAcross, integrationSentinels } from './leak-sentinels.js';
import type { Db } from '../../db/client.js';
import type { AppConfig } from '../config.js';
import type { AppDeps } from '../services/deps.js';

/**
 * The cross-app integration harness (issue #150).
 *
 * This is NOT `buildRouteApp`, and the difference is the whole point. `buildRouteApp` wires the
 * narratorr half as FAKE CLIENTS and the SMTP half as a fake transport, and registers one route
 * family at a time. `buildIntegrationApp` reads as a near-copy of `src/server/index.ts`'s wiring
 * section instead:
 *
 *   • connector config is written through the REAL `ConnectorSettingsService` (encrypted, DB-backed)
 *     and then READ BACK, so the narratorr client pair is built from stored ciphertext rather than
 *     from a hand-built config object, and sender resolution runs the genuine
 *     `resolveKindleSenderTransport` path;
 *   • `buildNarratorrConnection` builds the real `NarratorrClient` + `NarratorrStreamClient` pair
 *     behind ONE holder, and `buildKindleTransport` is the real non-pooled nodemailer factory;
 *   • `registerRoutes` registers EVERY route family, so capability → search → download → send is
 *     one continuous path through one app and one connection generation;
 *   • the app LISTENS on an ephemeral port, because truncation, backpressure and socket destruction
 *     are not observable through light-my-request's simulated socket.
 *
 * If this drifts from `src/server/index.ts`, the suite stops proving what it claims.
 */

const SESSION_SECRET = 'integration-test-secret';

/** The captured application log, as both parsed objects and the RAW serialized text (AC6). */
export interface IntegrationLogs {
  /** Every captured line, exactly as pino serialized it (newline trimmed). */
  readonly lines: readonly string[];
  /** The same lines, parsed. A line that is not JSON is kept as its raw string. */
  objects(): unknown[];
  /**
   * Every line joined — the haystack the leak sweep asserts against. RAW on purpose: a sentinel
   * nested in a structured field or inside an error `cause` must not slip past a field-wise check.
   */
  raw(): string;
}

export interface IntegrationHarness {
  app: FastifyInstance;
  /** `http://127.0.0.1:<ephemeral>` — scenarios drive this with real `fetch`, never `inject()`. */
  baseUrl: string;
  db: Db;
  users: UserService;
  connectorSettings: ConnectorSettingsService;
  logs: IntegrationLogs;
  /** A real signed session cookie header value for an already-seeded user. */
  cookieFor(user: { id: number; publicId: string }): string;
  close(): Promise<void>;
}

export interface BuildIntegrationAppOpts {
  /** The fake narratorr's base URL and the EXACT api key it authenticates against. */
  narratorr: { url: string; apiKey: string };
  /**
   * The fake SMTP server's coordinates plus the credentials it authenticates against. BOTH `user`
   * and `pass` are required for `buildKindleTransport` to attach `auth` at all.
   */
  smtp: { host: string; port: number; user: string; pass: string; from: string; to: string };
  /** The Requests-side admin opt-in (`app_settings.ebooks_enabled`). Default `true`. */
  ebooksEnabled?: boolean;
  /** Select the email notifier as the stable Kindle sender (issue #143). Default `true`. */
  selectKindleSender?: boolean;
}

export async function buildIntegrationApp(opts: BuildIntegrationAppOpts): Promise<IntegrationHarness> {
  const db = await createTestDb();
  const users = new UserService(db, {});
  const settings = new SettingsService(db);
  const settingsRow = await settings.ensure();

  // The capturing destination, installed as the Fastify logger's stream so EVERY service that takes
  // `app.log` (mirroring production) writes into it.
  const lines: string[] = [];
  const app = Fastify({
    logger: {
      level: 'info',
      stream: {
        write(line: string): void {
          lines.push(line.replace(/\n$/u, ''));
        },
      },
    },
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const codec = new SecretCodec(deriveSettingsKey({ sessionSecret: SESSION_SECRET }));
  const connectorSettings = new ConnectorSettingsService(db, codec, app.log);

  // Connector configuration goes in through the REAL service (so it is encrypted at rest and read
  // back through the real decrypt path) BEFORE the connection is built from it.
  await connectorSettings.update({
    narratorr: { url: opts.narratorr.url, apiKey: opts.narratorr.apiKey },
    ebooksEnabled: opts.ebooksEnabled ?? true,
  });
  const notifierRow = await connectorSettings.createNotifier({
    name: 'Library mail',
    type: 'email',
    events: [],
    config: {
      host: opts.smtp.host,
      port: opts.smtp.port,
      secure: false,
      user: opts.smtp.user,
      pass: opts.smtp.pass,
      from: opts.smtp.from,
      to: opts.smtp.to,
    },
  });
  if (opts.selectKindleSender ?? true) {
    await connectorSettings.update({ kindleSender: { notifierId: notifierRow.id } });
  }

  // One seam builds the whole narratorr graph — the REAL client pair, the holder that owns it, and
  // the capability resolver keyed to that holder's generation — from the STORED config.
  const { narratorr, features } = buildNarratorrConnection(await connectorSettings.getNarratorrConfig());

  const requesterEmail = new RequesterEmailService(() => connectorSettings.getNotificationsConfig());
  const requests = new RequestService(
    db,
    narratorr,
    await resolveRequestPolicy(connectorSettings, sanitizeAutoApproveRoles(settingsRow.autoApproveRoles, app.log)),
    { getNotifier: () => deps.notifier, users, requesterEmail, logger: app.log },
  );
  const search = new SearchService(narratorr);
  const companionEbooks = new CompanionEbookService(narratorr, narratorr, { connectorSettings, features }, app.log);
  const kindleSends = new KindleSendService({
    db,
    narratorr,
    companions: companionEbooks,
    settings: connectorSettings,
    // The REAL non-pooled nodemailer factory — the SMTP credentials must genuinely reach the wire.
    transport: buildKindleTransport,
    logger: app.log,
  });

  const config: AppConfig = {
    port: 0,
    bindHost: '127.0.0.1',
    isDev: true,
    isProd: false,
    corsOrigin: 'http://localhost',
    databasePath: ':memory:',
    sessionSecret: SESSION_SECRET,
    settingsKey: undefined,
    trustProxy: false,
    behindTls: false,
    authMode: 'standard',
    localAuth: true,
    oidcProviders: [],
    bootstrapAdmin: null,
  };

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
    companionEbooks,
    kindleSends,
    notifier,
    oidc: new Map(),
  };

  await app.register(cookie, { secret: SESSION_SECRET });
  await app.register(rateLimit, authRateLimitOptions);
  await app.register(errorHandlerPlugin);
  await app.register(authPlugin, deps);
  // EVERY route family, not a subset — capability, search, download and send must be one path
  // through one app.
  registerRoutes(app, deps);
  registerNotFoundHandler(app, { serveClient: false });

  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    app,
    baseUrl: `http://127.0.0.1:${port}`,
    db,
    users,
    connectorSettings,
    logs: {
      lines,
      objects: () =>
        lines.map((line) => {
          try {
            return JSON.parse(line) as unknown;
          } catch {
            return line;
          }
        }),
      raw: () => lines.join('\n'),
    },
    cookieFor: (user) => `${SESSION_COOKIE}=${createSessionToken({ uid: user.id, pid: user.publicId }, SESSION_SECRET)}`,
    close: async () => {
      // A scenario that leaves a response mid-stream would otherwise wedge `close()` on the socket.
      app.server.closeAllConnections();
      await app.close();
    },
  };
}

// ---- One scenario: both fakes + the app, torn down together ------------------

/**
 * The values every scenario injects. They double as leak sentinels, so their PROVENANCE is the
 * rule that keeps the sweep safe: each is configured by the suite and appears in no fixture title
 * or book id.
 */
export const INTEGRATION_API_KEY = NARRATORR_API_KEY;
export const INTEGRATION_KINDLE_ADDRESS = 'reader-sentinel@kindle.com';
export const INTEGRATION_SMTP_USER = 'smtp-sentinel-user';
export const INTEGRATION_SMTP_PASS = 'smtp-sentinel-pass-9f3c';
/** The selected notifier's `from` — the ONLY mailbox a Kindle send may come from. */
export const INTEGRATION_SENDER_FROM = 'library@example.com';

export interface IntegrationScenario extends IntegrationHarness {
  /** The real fake narratorr this app's client pair is pointed at. */
  upstream: FakeNarratorr;
  /** The real fake SMTP server the resolved Kindle sender is pointed at. */
  smtp: FakeSmtp;
  /** Seed an ACTIVE user and mint their real signed session cookie. */
  activeUser(opts?: { kindleEmail?: string | null }): Promise<{
    user: { id: number; publicId: string };
    cookie: string;
  }>;
  /**
   * AC21/AC22: sweep this response's body, ALL its headers and every captured log line. Invoked
   * from every scenario — including the failure branches — rather than living in an isolated
   * block, so a new scenario cannot forget it.
   */
  sweep(where: string, res: Response, body: string): void;
}

export interface StartScenarioOpts {
  ebooksEnabled?: boolean;
  selectKindleSender?: boolean;
}

/**
 * Boot both fakes and the app, wired to each other. `close()` tears down all three (AC7), so
 * `pnpm test` exits without a hanging handle.
 */
export async function startIntegrationScenario(opts: StartScenarioOpts = {}): Promise<IntegrationScenario> {
  const upstream = await startFakeNarratorr({ apiKey: INTEGRATION_API_KEY });
  const smtp = await startFakeSmtp({ user: INTEGRATION_SMTP_USER, pass: INTEGRATION_SMTP_PASS });
  const harness = await buildIntegrationApp({
    narratorr: { url: upstream.baseUrl, apiKey: INTEGRATION_API_KEY },
    smtp: {
      host: '127.0.0.1',
      port: smtp.port,
      user: INTEGRATION_SMTP_USER,
      pass: INTEGRATION_SMTP_PASS,
      from: INTEGRATION_SENDER_FROM,
      to: 'admin@example.com',
    },
    ...(opts.ebooksEnabled !== undefined && { ebooksEnabled: opts.ebooksEnabled }),
    ...(opts.selectKindleSender !== undefined && { selectKindleSender: opts.selectKindleSender }),
  });

  const sentinels = integrationSentinels({
    narratorrBaseUrl: upstream.baseUrl,
    kindleAddress: INTEGRATION_KINDLE_ADDRESS,
    smtpUser: INTEGRATION_SMTP_USER,
    smtpPass: INTEGRATION_SMTP_PASS,
  });

  return {
    ...harness,
    upstream,
    smtp,
    activeUser: async (userOpts = {}) => {
      const user = await insertUser(harness.db, {
        role: 'user',
        status: 'active',
        kindleEmail: userOpts.kindleEmail ?? null,
      });
      return { user, cookie: harness.cookieFor(user) };
    },
    sweep: (where, res, body) => {
      expectNoLeaksAcross(
        sentinels,
        { body, headers: Object.fromEntries(res.headers), logs: harness.logs.raw() },
        where,
      );
    },
    close: async () => {
      await harness.close();
      await Promise.all([upstream.close(), smtp.close()]);
    },
  };
}

/** Assert an exchange authenticated with the configured api key (AC1b's positive receipt). */
export function expectKeyAccepted(upstream: FakeNarratorr, pathSuffix: string): void {
  const receipts = upstream.receiptsFor(pathSuffix);
  expect(receipts.length, `no upstream request reached ${pathSuffix}`).toBeGreaterThan(0);
  expect(receipts.every((r) => r.keyMatched), `${pathSuffix} was served without the configured api key`).toBe(true);
}
