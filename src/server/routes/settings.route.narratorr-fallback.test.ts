import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
// Type-only namespace import (erased at runtime, so it doesn't fight the mock below) —
// gives importActual its return type without an inline `import()` annotation.
import type * as NarratorrClientModule from '../services/narratorr-client.js';

// The narratorr probe builds a concrete `new NarratorrClient(...).ping()`, and a real
// network reject is already mapped to NarratorrError(0, 'NETWORK', …) inside the client —
// so the non-NarratorrError fallback in describeNarratorrError() (`settings.ts:28`) is
// unreachable through a fetch stub. Module-mock the client so ping() throws a *plain*
// Error, and keep the real NarratorrError so the `instanceof` check behaves as in prod.
vi.mock('../services/narratorr-client.js', async (importActual) => {
  const actual = await importActual<typeof NarratorrClientModule>();
  return {
    ...actual,
    NarratorrClient: class {
      constructor(_opts: unknown) {}
      async ping(): Promise<void> {
        throw new Error('boom');
      }
    },
  };
});

import { createTestDb } from '../test-support/db.js';
import { SettingsService } from '../services/settings.service.js';
import { ConnectorSettingsService } from '../services/connector-settings.service.js';
import { SecretCodec, deriveSettingsKey } from '../util/secret-codec.js';
import { NarratorrClientHolder } from '../services/narratorr-client-holder.js';
import { FeatureService } from '../services/feature.service.js';
import { Notifier } from '../services/notifications/index.js';
import { errorHandlerPlugin } from '../plugins/error-handler.js';
import { registerSettingsRoutes } from './settings.js';
import type { AppDeps } from '../services/deps.js';
import type { AuthUser } from '../types.js';

const codec = new SecretCodec(deriveSettingsKey({ sessionSecret: 'route-test' }));
const silentLog = { info() {}, warn() {}, error() {}, debug() {} };
const ADMIN: AuthUser = { id: 1, publicId: 'us_admin', username: 'admin', role: 'admin', status: 'active' };

let app: FastifyInstance;
let connectorSettings: ConnectorSettingsService;

async function buildApp(): Promise<FastifyInstance> {
  const db = await createTestDb();
  await new SettingsService(db).ensure();
  connectorSettings = new ConnectorSettingsService(db, codec);
  // ONE holder, shared as both the client slot and the resolver's connection generation — the
  // production shape since #145 (a narratorr save swaps the connection, and that swap is what
  // retires the capability cache). Two separate holders would let this builder pass while the
  // real wiring diverged.
  const narratorr = new NarratorrClientHolder(null);
  const deps = {
    connectorSettings,
    narratorr,
    features: new FeatureService(narratorr, narratorr),
    notifier: new Notifier([], null, silentLog),
    requests: { reconfigureQuota: vi.fn() },
  } as unknown as AppDeps;

  const f = Fastify().withTypeProvider<ZodTypeProvider>();
  f.setValidatorCompiler(validatorCompiler);
  f.setSerializerCompiler(serializerCompiler);
  await f.register(errorHandlerPlugin);
  f.addHook('onRequest', async (req) => {
    if (req.headers['x-test-role'] === 'admin') req.user = ADMIN;
  });
  registerSettingsRoutes(f, deps);
  await f.ready();
  return f;
}

beforeEach(async () => {
  app = await buildApp();
});
afterEach(async () => {
  await app.close();
  vi.restoreAllMocks();
});

describe('settings routes — narratorr generic (non-NarratorrError) fallback', () => {
  it('falls through to err.message when ping() throws a plain Error', async () => {
    await connectorSettings.update({ narratorr: { url: 'https://n.example.com:443', apiKey: 'k' } });
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/settings/connectors/test',
      headers: { 'x-test-role': 'admin' },
      // Candidate mirrors the stored connection (key omitted → resolves to the stored one),
      // so buildCandidateNarratorrConfig yields a config and the mocked ping() runs.
      payload: { channel: 'narratorr', narratorr: { url: 'https://n.example.com:443' } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: false, message: 'boom' });
  });
});
