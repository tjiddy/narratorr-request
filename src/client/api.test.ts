import { describe, it, expect, vi, afterEach } from 'vitest';
import { getMe, requestBookFrom, listMyRequests, listAdminQueue, listUserRequests, ApiError } from './api';
import type { V1AudibleResult } from '@shared/schemas/v1/metadata';

// parse<T> (api.ts:23) is a private module function — not exported — so its HTTP
// failure contract is exercised through an exported wrapper (`getMe`) that ends in
// `.then(parse<…>)`, with a stubbed `fetch`. Response.text() is single-use, so each
// stubbed call returns a FRESH Response (mockResolvedValueOnce).
function stubFetch(res: Response): ReturnType<typeof vi.fn> {
  const mock = vi.fn().mockResolvedValueOnce(res);
  vi.stubGlobal('fetch', mock);
  return mock;
}

afterEach(() => vi.unstubAllGlobals());

describe('parse (via getMe wrapper)', () => {
  it('resolves undefined on an ok response with an empty body', async () => {
    stubFetch(new Response('', { status: 200 }));
    await expect(getMe()).resolves.toBeUndefined();
  });

  it('resolves the parsed object on an ok JSON response', async () => {
    stubFetch(new Response(JSON.stringify({ user: { username: 'todd' } }), { status: 200 }));
    await expect(getMe()).resolves.toEqual({ user: { username: 'todd' } });
  });

  it('rejects with ApiError carrying exact status/code/message from a full envelope', async () => {
    stubFetch(new Response(JSON.stringify({ error: { code: 'FORBIDDEN', message: 'nope' } }), { status: 403 }));
    const err = await getMe().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 403, code: 'FORBIDDEN', message: 'nope' });
  });

  it('falls back the code to HTTP_${status} when the envelope omits code', async () => {
    stubFetch(new Response(JSON.stringify({ error: { message: 'broke' } }), { status: 500 }));
    const err = await getMe().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 500, code: 'HTTP_500', message: 'broke' });
  });

  it('keeps the envelope code but falls back the message when only the code is present', async () => {
    stubFetch(new Response(JSON.stringify({ error: { code: 'X' } }), { status: 418 }));
    const err = await getMe().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 418, code: 'X', message: 'Request failed (418)' });
  });

  it('falls back both code and message for an empty error object', async () => {
    stubFetch(new Response(JSON.stringify({ error: {} }), { status: 502 }));
    const err = await getMe().catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 502, code: 'HTTP_502', message: 'Request failed (502)' });
  });

  it('falls back when the envelope is missing entirely', async () => {
    stubFetch(new Response(JSON.stringify({}), { status: 404 }));
    const err = await getMe().catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 404, code: 'HTTP_404', message: 'Request failed (404)' });
  });

  it('maps a non-JSON error body to code NON_JSON', async () => {
    stubFetch(new Response('<html>502 Bad Gateway</html>', { status: 502 }));
    const err = await getMe().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 502, code: 'NON_JSON', message: 'Unexpected non-JSON response (502)' });
  });
});

describe('requestBookFrom body builder', () => {
  const base: V1AudibleResult = {
    asin: 'B07',
    title: 'Dune',
    authors: [],
    narrators: [],
    cover: null,
  };

  async function captureBody(result: V1AudibleResult): Promise<Record<string, unknown>> {
    const mock = stubFetch(new Response(JSON.stringify({}), { status: 200 }));
    await requestBookFrom(result);
    const init = mock.mock.calls[0]![1] as RequestInit;
    return JSON.parse(init.body as string);
  }

  it('sends author:null / narrator:null for empty credit arrays', async () => {
    const body = await captureBody({ ...base, authors: [], narrators: [] });
    expect(body).toMatchObject({ asin: 'B07', title: 'Dune', author: null, narrator: null });
  });

  it('takes only the first author and first narrator', async () => {
    const body = await captureBody({
      ...base,
      authors: [{ name: 'Alice' }, { name: 'B' }],
      narrators: [{ name: 'Bob' }],
    });
    expect(body.author).toBe('Alice');
    expect(body.narrator).toBe('Bob');
  });

  it('renames `cover` to `coverUrl` (present and null)', async () => {
    expect(await captureBody({ ...base, cover: 'https://img/c.jpg' })).toMatchObject({
      coverUrl: 'https://img/c.jpg',
    });
    expect(await captureBody({ ...base, cover: null })).toMatchObject({ coverUrl: null });
  });

  it('preserves a public https cover', async () => {
    const body = await captureBody({ ...base, cover: 'https://m.media-amazon.com/images/I/x.jpg' });
    expect(body.coverUrl).toBe('https://m.media-amazon.com/images/I/x.jpg');
  });

  it('drops a cover that fails the shared SSRF guard to null instead of failing the create', async () => {
    expect((await captureBody({ ...base, cover: 'http://m.media-amazon.com/x.jpg' })).coverUrl).toBeNull();
    expect((await captureBody({ ...base, cover: 'https://192.168.0.22/x.jpg' })).coverUrl).toBeNull();
    expect((await captureBody({ ...base, cover: 'not a url' })).coverUrl).toBeNull();
  });
});

// The list wrappers build the paging query string from optional limit/offset and return
// the envelope's `total` to the caller. The URL is asserted from the stubbed fetch call.
describe('list wrappers — paging query string + total pass-through', () => {
  const envelope = (total: number) => new Response(JSON.stringify({ data: [], total }), { status: 200 });
  const urlOf = (mock: ReturnType<typeof vi.fn>) => mock.mock.calls[0]![0] as string;

  describe('listMyRequests', () => {
    it('with no arguments requests the bare /api/requests — no limit/offset (Search no-regression, AC5)', async () => {
      const mock = stubFetch(envelope(0));
      await listMyRequests();
      expect(urlOf(mock)).toBe('/api/requests');
    });

    it('emits limit (and offset) when given, and returns the parsed total', async () => {
      const mock = stubFetch(envelope(137));
      const res = await listMyRequests({ limit: 100 });
      expect(urlOf(mock)).toBe('/api/requests?limit=100');
      expect(res.total).toBe(137);

      const mock2 = stubFetch(envelope(5));
      await listMyRequests({ limit: 50, offset: 100 });
      expect(urlOf(mock2)).toBe('/api/requests?limit=50&offset=100');
    });
  });

  describe('listAdminQueue', () => {
    it('with no arguments requests the bare /api/admin/requests', async () => {
      const mock = stubFetch(envelope(0));
      await listAdminQueue();
      expect(urlOf(mock)).toBe('/api/admin/requests');
    });

    it('combines the status filter with the paging params', async () => {
      const mock = stubFetch(envelope(0));
      await listAdminQueue('pending', { limit: 100 });
      expect(urlOf(mock)).toBe('/api/admin/requests?status=pending&limit=100');
    });

    it('keeps the bare status-only URL when no paging is passed', async () => {
      const mock = stubFetch(envelope(0));
      await listAdminQueue('available');
      expect(urlOf(mock)).toBe('/api/admin/requests?status=available');
    });
  });

  describe('listUserRequests', () => {
    it('appends the paging params to the per-user history URL', async () => {
      const mock = stubFetch(envelope(0));
      await listUserRequests('us_abc', { limit: 150 });
      expect(urlOf(mock)).toBe('/api/admin/users/us_abc/requests?limit=150');
    });

    it('with no paging requests the bare per-user URL', async () => {
      const mock = stubFetch(envelope(0));
      await listUserRequests('us_abc');
      expect(urlOf(mock)).toBe('/api/admin/users/us_abc/requests');
    });
  });
});
