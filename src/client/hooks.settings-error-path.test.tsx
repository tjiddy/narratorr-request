import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ConnectorSettingsDto, UpdateConnectorSettingsBody } from '@shared/schemas/connectors';
import type { FeaturesDto } from '@shared/schemas/features';
import type { MeDto } from '@shared/schemas/user';
import {
  useConnectorSettings,
  useFeatures,
  useUpdateConnectors,
  useUpdateEbooksEnabled,
  useUpdateKindleSender,
  useCreateNotifier,
  useUpdateNotifier,
  useDeleteNotifier,
} from './hooks';

/**
 * COMMIT-THEN-ERROR reconciliation, proven at the API boundary against a real QueryClient (#144
 * F5/F6/F8).
 *
 * Every `/api/admin/settings/*` write persists BEFORE awaiting its fallible reconfiguration tail
 * (`routes/settings.ts`), so a 500 is not evidence that nothing was written — the server's own
 * rejecting-tail tests assert exactly that pairing. The client therefore reconciles from
 * `onSettled` rather than `onSuccess`.
 *
 * `hooks.test.ts` can only assert that the invalidation was REQUESTED: it mocks
 * `@tanstack/react-query`, so there is no cache, no observer and no refetch there. That makes it
 * the wrong layer for this claim — the consequence that matters is that mounted observers END UP
 * on the committed row after a rejected mutation. So this file runs the real QueryClient, the real
 * hooks, and a fake server whose writes COMMIT and then answer non-2xx, and asserts the settled
 * data of both the connectors and features observers.
 *
 * One case per distinct trigger family in `reconcileConnectorWrite`:
 *   • body-sensitive connector writes — narratorr (retires features) vs publicUrl (must not);
 *   • always-feature writes — the ebook toggle and the Kindle-sender selection;
 *   • connector-only — notifier create (a fresh id can never be the selected sender);
 *   • feature-retiring — notifier edit and delete.
 */

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const CONNECTORS_URL = '/api/admin/settings/connectors';
const NOTIFIERS_URL = '/api/admin/settings/notifiers';
const FEATURES_URL = '/api/features';

const ME: MeDto = { publicId: 'us_1', username: 'admin', role: 'admin', status: 'active' } as MeDto;

const notifier = (id: string, from: string) => ({
  id,
  name: `Mail ${id}`,
  type: 'email' as const,
  events: ['request.created' as const],
  config: { host: 'smtp.example.com', port: 587, secure: false, user: null, from, to: 'a@ex.com', hasPassword: true },
});

const baseRow = (): ConnectorSettingsDto => ({
  publicUrl: null,
  narratorr: null,
  notifiers: [notifier('nf_1', 'bot@ex.com')],
  defaultQuota: { mode: 'limited', limit: 10, windowDays: 30 },
  requesterEmailWarning: false,
  kindleSender: null,
  ebooksEnabled: false,
});

const jsonRes = (status: number, payload: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(payload)),
  }) as unknown as Response;

/**
 * A fake settings API over one authoritative `row`, mirroring the server's ordering: every write
 * COMMITS first and only then decides its status code. With `failWrites` on, each write commits and
 * answers 500 — the exact durable-write-then-reconfiguration-failure shape.
 *
 * `/api/features` is derived from the row the way `deriveFeatures` does, so a write that changes
 * the derived payload is observable through the features query rather than assumed.
 */
function fakeServer(opts: { failWrites?: boolean } = {}) {
  const row = baseRow();
  const counts = { connectorsGet: 0, featuresGet: 0 };
  // Each notifier's live `from`, kept beside the masked DTO list. This mirrors the server, which
  // resolves the Kindle sender against the DECRYPTED runtime notifiers rather than the masked
  // response shape — and it keeps the fake independent of how `NotifierDto` types its config.
  const senderFrom = new Map<string, string>([['nf_1', 'bot@ex.com']]);
  const liveFrom = (id: string): string | null => senderFrom.get(id) ?? null;

  /** Mirrors `deriveFeatures`: capability stands in as "a narratorr connection is configured". */
  const features = (): FeaturesDto => {
    const ebooksEnabled = row.ebooksEnabled && row.narratorr !== null;
    if (!ebooksEnabled) return { ebooksEnabled: false, kindleDeliveryAvailable: false, kindleSenderEmail: null };
    const sender = row.kindleSender;
    // Resolved at READ time against the live notifier list — the whole reason notifier edit and
    // delete can change this payload without touching the selection itself.
    const ok = sender !== null && liveFrom(sender.notifierId) === sender.confirmedFrom;
    const kindleSenderEmail = ok && sender ? sender.confirmedFrom : null;
    return { ebooksEnabled: true, kindleDeliveryAvailable: kindleSenderEmail !== null, kindleSenderEmail };
  };

  /** The status a committed write answers with — 500 models the failed reconfiguration tail. */
  const writeStatus = () => (opts.failWrites ? 500 : 200);
  const writeBody = (okBody: unknown) =>
    opts.failWrites ? { error: { code: 'RECONFIGURE_FAILED', message: 'reconfiguration failed' } } : okBody;

  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;

    if (url === FEATURES_URL) {
      counts.featuresGet += 1;
      return Promise.resolve(jsonRes(200, features()));
    }

    if (url.startsWith(NOTIFIERS_URL)) {
      const id = url.slice(NOTIFIERS_URL.length + 1);
      if (method === 'POST') {
        // COMMIT: a brand-new id, which by construction no stored selection can already name.
        const newId = `nf_${row.notifiers.length + 1}`;
        const newFrom = String(body?.['from'] ?? 'new@ex.com');
        senderFrom.set(newId, newFrom);
        row.notifiers = [...row.notifiers, notifier(newId, newFrom)];
        return Promise.resolve(jsonRes(writeStatus(), writeBody(row.notifiers.at(-1))));
      }
      if (method === 'PUT') {
        // COMMIT: editing the selected notifier's `from` is what flips the sender to
        // `sender-changed`, dropping Kindle delivery.
        const nextFrom = String(body?.['from'] ?? 'changed@ex.com');
        senderFrom.set(id, nextFrom);
        row.notifiers = row.notifiers.map((n) => (n.id === id ? notifier(id, nextFrom) : n));
        return Promise.resolve(jsonRes(writeStatus(), writeBody(row.notifiers.find((n) => n.id === id))));
      }
      if (method === 'DELETE') {
        senderFrom.delete(id);
        row.notifiers = row.notifiers.filter((n) => n.id !== id); // COMMIT
        return Promise.resolve(jsonRes(writeStatus(), writeBody({ ok: true })));
      }
    }

    if (url.startsWith(CONNECTORS_URL)) {
      if (method !== 'PUT') {
        counts.connectorsGet += 1;
        return Promise.resolve(jsonRes(200, { ...row }));
      }
      // COMMIT, then decide the status — the server's persist-before-fallible-tail ordering.
      const put = body as UpdateConnectorSettingsBody & { kindleSender?: { notifierId: string } | null };
      if (put.publicUrl !== undefined) row.publicUrl = put.publicUrl;
      if (put.narratorr !== undefined) {
        row.narratorr = put.narratorr ? { url: put.narratorr.url, hasApiKey: true } : null;
      }
      if (put.ebooksEnabled !== undefined) row.ebooksEnabled = put.ebooksEnabled;
      if (put.kindleSender !== undefined) {
        const sel = put.kindleSender;
        // The server derives `confirmedFrom` from the notifier's LIVE from at write time.
        const from = sel ? liveFrom(sel.notifierId) : null;
        row.kindleSender =
          sel && from !== null
            ? { notifierId: sel.notifierId, confirmedFrom: from, status: 'ok', currentFrom: from }
            : null;
      }
      return Promise.resolve(jsonRes(writeStatus(), writeBody({ ...row })));
    }

    throw new Error(`unstubbed fetch: ${method} ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);

  return { row, counts, features };
}

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

/**
 * Mount both readers and every settings mutation in ONE component, the way the Settings page does.
 * They must share a render root, not merely a QueryClient — separate roots re-render
 * independently, so a cache correction reaching one is not observable through another's snapshot.
 */
function mountSettings(client: QueryClient) {
  return renderHook(
    () => ({
      connectors: useConnectorSettings(),
      features: useFeatures(ME),
      updateConnectors: useUpdateConnectors(),
      toggle: useUpdateEbooksEnabled(),
      sender: useUpdateKindleSender(),
      createNotifier: useCreateNotifier(),
      updateNotifier: useUpdateNotifier(),
      deleteNotifier: useDeleteNotifier(),
    }),
    { wrapper: wrapper(client) },
  );
}

/** A client that does NOT retry, so a 500 settles as one clean rejection. */
const newClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('settings writes that COMMIT and then 500 still reconcile the real observers (#144 F5/F6/F8)', () => {
  /** Boot the page with both queries loaded and a server whose writes commit then fail. */
  async function bootFailing(seed?: (server: ReturnType<typeof fakeServer>) => void) {
    const server = fakeServer({ failWrites: true });
    seed?.(server);
    const client = newClient();
    const { result } = mountSettings(client);
    await waitFor(() => {
      expect(result.current.connectors.isSuccess).toBe(true);
      expect(result.current.features.isSuccess).toBe(true);
    });
    return { server, client, result };
  }

  it('narratorr write: rejects, yet BOTH observers converge on the committed row', async () => {
    const { server, result } = await bootFailing((s) => {
      s.row.ebooksEnabled = true; // so a narratorr connection flips the derived payload
    });
    // Baseline: no connection, so the feature reads off.
    expect(result.current.features.data).toMatchObject({ ebooksEnabled: false });

    result.current.updateConnectors.mutate({ narratorr: { url: 'http://n:3000', apiKey: 'k' } });

    // The mutation genuinely FAILED — we are on the error path, not accidentally succeeding.
    await waitFor(() => expect(result.current.updateConnectors.isError).toBe(true));
    expect(server.row.narratorr).toMatchObject({ url: 'http://n:3000' }); // …but the write is durable

    await waitFor(() => {
      expect(result.current.connectors.data?.narratorr).toMatchObject({ url: 'http://n:3000' });
      // …and the body-sensitive trigger retired the feature query on the ERROR path too.
      expect(result.current.features.data).toMatchObject({ ebooksEnabled: true });
    });
  });

  it('publicUrl write: reconciles connectors WITHOUT refetching features (trigger is the body, not the outcome)', async () => {
    const { server, result } = await bootFailing();
    const featureReadsBefore = server.counts.featuresGet;

    result.current.updateConnectors.mutate({ publicUrl: 'https://app.example.com' });
    await waitFor(() => expect(result.current.updateConnectors.isError).toBe(true));

    await waitFor(() => expect(result.current.connectors.data?.publicUrl).toBe('https://app.example.com'));
    // A publicUrl save cannot change the derived payload, so it must not pay for a refetch —
    // the same trigger set the server uses for `reconfigure(narratorrChanged)`.
    expect(server.counts.featuresGet).toBe(featureReadsBefore);
  });

  it('ebook toggle: rejects, yet both observers converge', async () => {
    const { server, result } = await bootFailing((s) => {
      s.row.narratorr = { url: 'http://n:3000', hasApiKey: true }; // capability half already on
    });
    expect(result.current.features.data).toMatchObject({ ebooksEnabled: false });

    result.current.toggle.mutate({ ebooksEnabled: true });
    await waitFor(() => expect(result.current.toggle.isError).toBe(true));
    expect(server.row.ebooksEnabled).toBe(true);

    await waitFor(() => {
      expect(result.current.connectors.data?.ebooksEnabled).toBe(true);
      expect(result.current.features.data).toMatchObject({ ebooksEnabled: true });
    });
  });

  it('Kindle-sender selection: rejects, yet delivery readiness appears', async () => {
    const { result } = await bootFailing((s) => {
      s.row.narratorr = { url: 'http://n:3000', hasApiKey: true };
      s.row.ebooksEnabled = true;
    });
    expect(result.current.features.data).toMatchObject({ kindleDeliveryAvailable: false, kindleSenderEmail: null });

    result.current.sender.mutate({ kindleSender: { notifierId: 'nf_1' } });
    await waitFor(() => expect(result.current.sender.isError).toBe(true));

    await waitFor(() => {
      expect(result.current.features.data).toMatchObject({
        kindleDeliveryAvailable: true,
        kindleSenderEmail: 'bot@ex.com',
      });
      expect(result.current.connectors.data?.kindleSender).toMatchObject({ notifierId: 'nf_1' });
    });
  });

  it('notifier CREATE: reconciles the list WITHOUT refetching features', async () => {
    const { server, result } = await bootFailing((s) => {
      s.row.narratorr = { url: 'http://n:3000', hasApiKey: true };
      s.row.ebooksEnabled = true;
    });
    const featureReadsBefore = server.counts.featuresGet;

    result.current.createNotifier.mutate({ name: 'New', type: 'email', events: ['request.created'], config: { from: 'x@ex.com' } } as never);
    await waitFor(() => expect(result.current.createNotifier.isError).toBe(true));

    // The committed list still reaches the UI…
    await waitFor(() => expect(result.current.connectors.data?.notifiers).toHaveLength(2));
    // …but a new id can never be the selected sender, so features stays untouched.
    expect(server.counts.featuresGet).toBe(featureReadsBefore);
  });

  it.each([
    [
      'notifier EDIT (selected sender becomes sender-changed)',
      (r: ReturnType<typeof mountSettings>['result']) =>
        r.current.updateNotifier.mutate({ id: 'nf_1', body: { from: 'changed@ex.com' } as never }),
      (r: ReturnType<typeof mountSettings>['result']) => r.current.updateNotifier.isError,
    ],
    [
      'notifier DELETE (selected sender becomes notifier-missing)',
      (r: ReturnType<typeof mountSettings>['result']) => r.current.deleteNotifier.mutate('nf_1'),
      (r: ReturnType<typeof mountSettings>['result']) => r.current.deleteNotifier.isError,
    ],
  ])('%s: rejects, yet Kindle readiness is withdrawn from the observer', async (_label, run, errored) => {
    const { result } = await bootFailing((s) => {
      s.row.narratorr = { url: 'http://n:3000', hasApiKey: true };
      s.row.ebooksEnabled = true;
      s.row.kindleSender = { notifierId: 'nf_1', confirmedFrom: 'bot@ex.com', status: 'ok', currentFrom: 'bot@ex.com' };
    });
    // Baseline: delivery is live before the write.
    await waitFor(() =>
      expect(result.current.features.data).toMatchObject({ kindleDeliveryAvailable: true, kindleSenderEmail: 'bot@ex.com' }),
    );

    run(result);
    await waitFor(() => expect(errored(result)).toBe(true));

    // The durable change withdrew delivery, and the SPA must stop advertising it despite the 500.
    await waitFor(() =>
      expect(result.current.features.data).toMatchObject({ kindleDeliveryAvailable: false, kindleSenderEmail: null }),
    );
  });
});
