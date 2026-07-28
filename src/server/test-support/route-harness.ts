import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { vi } from 'vitest';
import { createTestDb } from './db.js';
import { UserService } from '../services/user.service.js';
import { SettingsService } from '../services/settings.service.js';
import { ConnectorSettingsService } from '../services/connector-settings.service.js';
import { RequestService, type RequestPolicy } from '../services/request.service.js';
import { SearchService } from '../services/search.service.js';
import { NarratorrClientHolder } from '../services/narratorr-client-holder.js';
import { FeatureService } from '../services/feature.service.js';
import { Notifier } from '../services/notifications/notifier.service.js';
import type { NotifierLogger } from '../services/notifications/types.js';
import { SecretCodec, deriveSettingsKey } from '../util/secret-codec.js';
import { errorHandlerPlugin } from '../plugins/error-handler.js';
import { authRateLimitOptions } from '../plugins/rate-limit.js';
import { authPlugin, SESSION_COOKIE } from '../plugins/auth.js';
import { registerNotFoundHandler } from '../routes/not-found.js';
import { createSessionToken } from '../util/session.js';
import type { Db } from '../../db/client.js';
import type { AppConfig } from '../config.js';
import type { AppDeps } from '../services/deps.js';
import type { INarratorrClient } from '../services/narratorr-client.js';
import type { IEbookStreamClient, NarratorrEbookStream } from '../services/narratorr-stream-client.js';
import type { V1Book } from '../../shared/schemas/v1/books.js';
import type { V1System } from '../../shared/schemas/v1/system.js';
import type { V1Capabilities } from '../../shared/schemas/v1/capabilities.js';
import type { BookStatus } from '../../shared/schemas/book.js';
import type { AuthUser } from '../types.js';

const SESSION_SECRET = 'route-test-secret';

/** Header that selects a synthetic `request.user` on the role-override (header-shim) path. */
export const TEST_ROLE_HEADER = 'x-test-role';

/**
 * Synthetic users for the header-shim authz-override path — lifted from `settings.route.test.ts`
 * so authz-only route tests stop re-rolling that hook. These are NOT backed by DB rows: use them
 * for routes that only gate on `request.user`'s role/status (e.g. admin-only settings), NOT for
 * routes that load the user by id (request create looks the user up in the DB). For DB-backed
 * flows, seed a real user with `insertUser()` and authenticate via `cookieFor()`.
 *
 * The ids are high sentinels, deliberately NOT 1/2: seeded DB users autoincrement from 1, so a
 * low synthetic id would collide with a seeded owner and let an ownership match (`row.userId ===
 * user.id`) mask whether a role bypass actually fired. A 9000-range id can't realistically clash,
 * so a route that compares ids genuinely exercises the role override.
 */
export const TEST_ADMIN: AuthUser = { id: 9001, publicId: 'us_admin', username: 'admin', role: 'admin', status: 'active' };
export const TEST_USER: AuthUser = { id: 9002, publicId: 'us_user', username: 'user', role: 'user', status: 'active' };

/**
 * A successful fake Narratorr client whose `addBook()` resolves — the inverse of the
 * rejecting stub the auth-route test uses. The auto-approve (admin) create path hands off
 * to `addBook()`, so any route test that exercises it needs a client that succeeds rather
 * than 5xx'ing the handoff. `status` controls the book state the handoff observes
 * (`searching` → request lands `acquiring`; `imported` → `available`).
 */
export class FakeNarratorrClient implements INarratorrClient {
  status: BookStatus = 'searching';
  added: string[] = [];
  /** What the companion-ebook capability probe reports (issue #144) — flip per test. */
  companionEpub = true;
  /** How many times the capability probe was called — asserts the `/api/features` short-circuit. */
  capabilityCalls = 0;
  private seq = 0;

  async searchMetadata(): Promise<[]> {
    return [];
  }
  async addBook(asin: string): Promise<V1Book> {
    this.added.push(asin);
    this.seq += 1;
    return { id: `bk_${this.seq}`, title: 'A Book', authors: [], narrators: [], status: this.status };
  }
  async getBook(id: string): Promise<V1Book> {
    return { id, title: 'A Book', authors: [], narrators: [], status: this.status };
  }
  async getSystem(): Promise<V1System> {
    return { version: 'v1.0.0' };
  }
  async getCapabilities(): Promise<V1Capabilities> {
    this.capabilityCalls += 1;
    return { companionEpub: { enabled: this.companionEpub } };
  }
}

/**
 * The raw-stream half of a fake narratorr connection (issue #145). A connection is installed as a
 * PAIR, so the harness always wires one of these alongside {@link FakeNarratorrClient} — an
 * unconfigured holder then surfaces NOT_CONFIGURED through the stream just like every JSON call.
 */
export class FakeEbookStreamClient implements IEbookStreamClient {
  /** Every publicId opened, in order. */
  opened: string[] = [];
  contentType: string | null = 'application/epub+zip';
  /** The bytes the returned stream yields — set to size the fake companion per test. */
  bytes: Uint8Array = new Uint8Array([1, 2, 3]);
  /**
   * Split {@link bytes} across this many chunks (default: one). The proxy route reads the FIRST
   * chunk before committing any header, so a multi-chunk body is what distinguishes "streamed"
   * from "buffered whole and re-emitted".
   */
  chunks = 1;
  /**
   * Override the advertised content-length. `undefined` means "the real byte length"; `null`
   * means the header was absent upstream (chunked). Set `0` for the zero-length companion.
   */
  contentLength: number | null | undefined = undefined;
  /** Reject `openCompanionEpub()` itself — the header-phase failure. */
  openError: unknown = null;
  /** Reject the FIRST `read()`, before any header can be committed (AC25). */
  firstReadError: unknown = null;
  /** Reject AFTER the first chunk has been handed over (AC24's mid-body failure). */
  midStreamError: unknown = null;
  /** The `opts.signal` of the most recent open, so a test can observe the abort wiring. */
  lastSignal: AbortSignal | undefined = undefined;
  /** Awaited before the open resolves — lets a test park the handler mid-header-phase. */
  beforeOpen: (() => Promise<void>) | null = null;

  async openCompanionEpub(publicId: string, opts: { signal?: AbortSignal } = {}): Promise<NarratorrEbookStream> {
    this.lastSignal = opts.signal;
    if (this.beforeOpen) await this.beforeOpen();
    this.opened.push(publicId);
    if (this.openError) throw this.openError;
    const { bytes, chunks, firstReadError, midStreamError } = this;
    const size = Math.max(1, Math.ceil(bytes.byteLength / Math.max(1, chunks)));
    let offset = 0;
    let served = 0;
    return {
      contentType: this.contentType,
      contentLength: this.contentLength === undefined ? bytes.byteLength : this.contentLength,
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          if (served === 0 && firstReadError) throw firstReadError;
          if (served > 0 && midStreamError) throw midStreamError;
          if (offset >= bytes.byteLength) {
            controller.close();
            return;
          }
          controller.enqueue(bytes.subarray(offset, offset + size));
          offset += size;
          served += 1;
        },
      }),
    };
  }
}

/** What a built route-test app hands back: the Fastify instance plus the live wiring tests poke at. */
export interface RouteHarness {
  app: FastifyInstance;
  db: Db;
  users: UserService;
  requests: RequestService;
  /** The injected notifier dispatch spy — assert `toHaveBeenCalledTimes` / `not.toHaveBeenCalled`. */
  notify: ReturnType<typeof vi.fn>;
  /** The successful fake Narratorr client (mutate `.status`, inspect `.added`). */
  narratorr: FakeNarratorrClient;
  /** The fake companion-ebook stream half of the same connection (inspect `.opened`). */
  ebookStream: FakeEbookStreamClient;
  /**
   * The swappable holder wrapping {@link narratorr} — this is what `deps.narratorr` points at
   * (the health route reads `deps.narratorr.configured`; only the holder exposes that getter).
   * Call `.set(null)` to flip the app to the unconfigured state mid-test, or build the harness
   * with `narratorrConfigured: false` to start unconfigured.
   */
  narratorrHolder: NarratorrClientHolder;
  /** The real capability resolver wired into `deps.features` — drive `nowMs`, swap to retire it. */
  features: FeatureService;
  /** The real connector-settings service behind `deps.connectorSettings` — write the admin flags. */
  connectorSettings: ConnectorSettingsService;
  /** The real `SearchService` wired against {@link narratorrHolder} — spy on `.search` to force errors. */
  search: SearchService;
  config: AppConfig;
  /**
   * Mint a real signed session cookie for an already-seeded user — the DB-backed auth path.
   * Seed a user with any role/status via `insertUser()`, then become them. This goes through
   * the real `authPlugin`, so it exercises the genuine session → `request.user` boundary
   * instead of a parallel fixture of it.
   */
  cookieFor(user: { id: number; publicId: string }): Record<string, string>;
  /**
   * Header-shim role override for authz-only tests — selects a synthetic `request.user`
   * (`TEST_ADMIN` / `TEST_USER`, or the `roleUsers` override) without a DB row or cookie.
   * Use for routes that gate purely on role/status; pair with `cookieFor()` for DB-backed flows.
   */
  asRole(role: 'admin' | 'user'): Record<string, string>;
  /** The synthetic users the header shim injects (the `roleUsers` override or the defaults). */
  roleUsers: { admin: AuthUser; user: AuthUser };
}

export interface BuildRouteAppOpts {
  /** Register the route(s) under test against the wired-up deps. */
  register: (app: FastifyInstance, deps: AppDeps) => void;
  config?: Partial<AppConfig>;
  /** Override the default successful fake Narratorr client. */
  narratorr?: INarratorrClient;
  /** Override the default fake companion-ebook stream client. */
  ebookStream?: IEbookStreamClient;
  /**
   * Start with narratorr unconfigured (holder wraps `null`) so `deps.narratorr.configured` is
   * `false` and any search/handoff surfaces `NOT_CONFIGURED`. Defaults to `true` (configured).
   */
  narratorrConfigured?: boolean;
  /** Override the default request policy (defaultQuota 10 / windowDays 30 / admin auto-approve). */
  policy?: Partial<RequestPolicy>;
  /** Override the synthetic users the header-shim role override injects (default TEST_ADMIN / TEST_USER). */
  roleUsers?: { admin?: AuthUser; user?: AuthUser };
  /**
   * Install the test-only `x-test-role` header-shim authz override (the {@link asRole} path).
   * Off by default so the shim is obviously test-scoped and absent unless a test asks for it —
   * a route test that never opts in cannot use the header to bypass real authz. Tests that drive
   * authz via {@link asRole} must set this to `true`.
   */
  enableTestRoleOverride?: boolean;
}

/**
 * Build a Fastify app wired the way the real server is — error-handler, cookie, rate-limit,
 * and the real `authPlugin` — with the user-facing data services constructed against a fresh
 * in-memory libSQL db. Routes are registered via `opts.register` so each route-test file (this
 * one, and the follow-up admin-route issue) shares one harness instead of re-rolling the app.
 */
export async function buildRouteApp(opts: BuildRouteAppOpts): Promise<RouteHarness> {
  const db = await createTestDb();
  const settings = new SettingsService(db);
  await settings.ensure();
  const codec = new SecretCodec(deriveSettingsKey({ sessionSecret: SESSION_SECRET }));
  const connectorSettings = new ConnectorSettingsService(db, codec);
  const users = new UserService(db, {});
  const narratorr = opts.narratorr ?? new FakeNarratorrClient();
  const ebookStream = opts.ebookStream ?? new FakeEbookStreamClient();
  // Mirror production wiring (src/server/index.ts): a single swappable holder owns the WHOLE
  // connection (JSON + raw stream) and is shared by RequestService and SearchService, so an
  // unconfigured holder surfaces NOT_CONFIGURED through every path — the stream included — and
  // the health route can read `deps.narratorr.configured`.
  const narratorrHolder = new NarratorrClientHolder(
    (opts.narratorrConfigured ?? true) ? { json: narratorr, stream: ebookStream } : null,
  );
  const search = new SearchService(narratorrHolder);
  // Mirrors production wiring: the resolver reads the same swappable holder for BOTH the probe
  // and its cache generation, so a route test can flip `narratorr.companionEpub` (or `.set(null)`,
  // which retires the cache) and observe it through `/api/features`.
  const features = new FeatureService(narratorrHolder, narratorrHolder);
  // A real Notifier (no channels → inert) with its `notify` swapped for a spy, so route tests
  // can assert dispatch without a structural cast. Building the genuine type means a new required
  // AppDeps field surfaces as a compile error here instead of a silent runtime `undefined`.
  const notify = vi.fn().mockResolvedValue(undefined);
  const notifierLog: NotifierLogger = { info() {}, warn() {}, error() {}, debug() {} };
  const notifier = new Notifier([], null, notifierLog);
  notifier.notify = notify;
  // Wire the request.failed notify deps the way production does (src/server/index.ts): a LIVE
  // accessor over the notifier (not a captured instance) plus the real UserService, so a terminal
  // handoff failure reached at the route boundary dispatches request.failed through the same spy.
  const requests = new RequestService(
    db,
    narratorrHolder,
    {
      defaultQuota: { mode: 'limited', limit: 10 },
      windowDays: 30,
      autoApproveRoles: ['admin'],
      ...opts.policy,
    },
    { getNotifier: () => notifier, users, logger: notifierLog },
  );
  // Full AppConfig (not a partial cast): adding a required config field fails to compile here.
  const config: AppConfig = {
    port: 3000,
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
    ...opts.config,
  };
  // Genuinely-typed AppDeps: a new required dep field is a compile error here, not a runtime hole.
  const deps: AppDeps = {
    config,
    db,
    users,
    settings,
    requests,
    search,
    connectorSettings,
    narratorr: narratorrHolder,
    features,
    notifier,
    oidc: new Map(),
  };

  const roleUsers = {
    admin: opts.roleUsers?.admin ?? TEST_ADMIN,
    user: opts.roleUsers?.user ?? TEST_USER,
  };

  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(cookie, { secret: SESSION_SECRET });
  await app.register(rateLimit, authRateLimitOptions);
  await app.register(errorHandlerPlugin);
  await app.register(authPlugin, deps);
  // Header-shim role override (mirrors settings.route.test.ts), opt-in only. Runs AFTER
  // authPlugin's onRequest hook so a test that sends the header wins; tests that send a real
  // cookie and no header are untouched. Inert unless the header is present — and absent entirely
  // unless the test opts in, so the shim can't silently bypass authz in tests that don't ask.
  if (opts.enableTestRoleOverride) {
    app.addHook('onRequest', async (req) => {
      const role = req.headers[TEST_ROLE_HEADER];
      if (role === 'admin') req.user = roleUsers.admin;
      else if (role === 'user') req.user = roleUsers.user;
    });
  }
  opts.register(app, deps);
  // Production's 404, via the SHARED registrar (issue #146 AC35). Without it a route test would
  // assert Fastify's default not-found body, which no client of this app ever receives — and the
  // router-miss shapes for `/api/ebooks/:bookId/download` are precisely the ones that answer here
  // rather than in a handler. `serveClient: false` matches the API-only boot branch.
  registerNotFoundHandler(app, { serveClient: false });
  await app.ready();

  return {
    app,
    db,
    users,
    requests,
    notify,
    narratorr: narratorr as FakeNarratorrClient,
    ebookStream: ebookStream as FakeEbookStreamClient,
    narratorrHolder,
    features,
    connectorSettings,
    search,
    config,
    roleUsers,
    cookieFor: (user) => ({
      [SESSION_COOKIE]: createSessionToken({ uid: user.id, pid: user.publicId }, SESSION_SECRET),
    }),
    asRole: (role) => ({ [TEST_ROLE_HEADER]: role }),
  };
}

/** Pluck the session cookie out of an `inject()` response (the real-auth-flow login path). */
export function sessionCookie(res: { cookies: Array<{ name: string; value: string }> }): Record<string, string> {
  const c = res.cookies.find((x) => x.name === SESSION_COOKIE);
  if (!c) throw new Error('no session cookie set');
  return { [SESSION_COOKIE]: c.value };
}
