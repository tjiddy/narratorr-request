import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

// Hoisted so the mock factory can reference them (vi.mock is hoisted above imports).
const { sendMail, createTransport } = vi.hoisted(() => {
  const sendMail = vi.fn();
  return { sendMail, createTransport: vi.fn((_opts?: unknown) => ({ sendMail })) };
});
vi.mock('nodemailer', () => ({
  default: { createTransport },
}));

import { NtfyChannel } from './adapters/ntfy.js';
import { WebhookChannel } from './adapters/webhook.js';
import { EmailChannel } from './adapters/email.js';
import { DiscordChannel } from './adapters/discord.js';
import { SlackChannel } from './adapters/slack.js';
import { TelegramChannel } from './adapters/telegram.js';
import { PushoverChannel } from './adapters/pushover.js';
import { GotifyChannel } from './adapters/gotify.js';
import type { NotificationChannel, SendContext } from './types.js';
import type { NotifierType } from '../../../shared/notifier-registry.js';

const ctx: SendContext = {
  payload: {
    event: 'request.created',
    request: { publicId: 'rq_1', title: 'Dune', author: 'Frank Herbert', asin: 'B1', coverUrl: 'https://x/c.jpg' },
    requester: { username: 'todd' },
  },
  message: {
    title: 'New audiobook request',
    body: 'todd requested “Dune” by Frank Herbert.',
    url: 'https://req.example.com/admin',
    linkLabel: 'Open the request queue',
  },
};

// A user.pending event carries no request/cover — adapters that read the payload
// directly must narrow on `event` instead of assuming a request is present.
const userCtx: SendContext = {
  payload: {
    event: 'user.pending',
    user: { publicId: 'us_1', username: 'newbie', email: 'newbie@x.com', authProvider: 'authelia' },
  },
  message: {
    title: 'New user awaiting approval',
    body: 'newbie (newbie@x.com) signed up via authelia and is waiting for your approval.',
    url: 'https://req.example.com/users',
    linkLabel: 'Review pending users',
  },
};

// A request.failed event is request-shaped (carries request + requester) PLUS a reason —
// adapters must serialize it like request.created (not as a `user` shape) and attach its cover.
const failedCtx: SendContext = {
  payload: {
    event: 'request.failed',
    request: { publicId: 'rq_9', title: 'Dune', author: 'Frank Herbert', asin: 'B9', coverUrl: 'https://x/c.jpg' },
    requester: { username: 'todd' },
    reason: 'No source found upstream.',
  },
  message: {
    title: 'Request failed',
    body: '“Dune” failed to acquire by Frank Herbert: No source found upstream.',
    url: 'https://req.example.com/admin',
    linkLabel: 'Open the request queue',
  },
};

describe('NtfyChannel', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('POSTs the body to <url>/<topic> with title/click/icon headers + bearer', async () => {
    const ch = new NtfyChannel({ url: 'https://ntfy.sh', topic: 'narr', token: 'tok', priority: 'high' });
    await ch.send(ctx);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://ntfy.sh/narr');
    expect(init.method).toBe('POST');
    expect(init.body).toContain('Dune');
    expect(init.headers.Title).toBe('New audiobook request');
    expect(init.headers.Click).toBe('https://req.example.com/admin');
    expect(init.headers.Icon).toBe('https://x/c.jpg');
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(init.headers.Priority).toBe('high');
  });

  it('throws on a non-2xx response so the dispatcher logs it', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 500 }));
    const ch = new NtfyChannel({ url: 'https://ntfy.sh', topic: 'narr', token: null, priority: null });
    await expect(ch.send(ctx)).rejects.toThrow(/500/);
  });

  it('omits the Icon header for an event with no cover (user.pending)', async () => {
    const ch = new NtfyChannel({ url: 'https://ntfy.sh', topic: 'narr', token: null, priority: null });
    await ch.send(userCtx);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers.Icon).toBeUndefined();
    expect(init.headers.Click).toBe('https://req.example.com/users');
  });

  it('attaches the cover Icon for a request.failed event (request-shaped, via data presence)', async () => {
    const ch = new NtfyChannel({ url: 'https://ntfy.sh', topic: 'narr', token: null, priority: null });
    await ch.send(failedCtx);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers.Icon).toBe('https://x/c.jpg');
    expect(init.headers.Title).toBe('Request failed');
  });
});

describe('WebhookChannel', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('POSTs JSON with a Discord-compatible content string plus structured fields', async () => {
    const ch = new WebhookChannel({ url: 'https://discord/webhook' });
    await ch.send(ctx);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://discord/webhook');
    expect(init.headers['content-type']).toBe('application/json');
    const body = JSON.parse(init.body);
    expect(body.content).toContain('Dune');
    expect(body.content).toContain('https://req.example.com/admin');
    expect(body.event).toBe('request.created');
    expect(body.request.asin).toBe('B1');
    expect(body.requester.username).toBe('todd');
  });

  it('carries the user (not a request) for a user.pending event', async () => {
    const ch = new WebhookChannel({ url: 'https://discord/webhook' });
    await ch.send(userCtx);

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.event).toBe('user.pending');
    expect(body.user.username).toBe('newbie');
    expect(body.request).toBeUndefined();
  });

  it('carries request + requester + reason for a request.failed event (not a user shape)', async () => {
    const ch = new WebhookChannel({ url: 'https://discord/webhook' });
    await ch.send(failedCtx);

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.event).toBe('request.failed');
    expect(body.request.asin).toBe('B9');
    expect(body.requester.username).toBe('todd');
    expect(body.reason).toBe('No source found upstream.');
    expect(body.user).toBeUndefined();
  });
});

describe('EmailChannel', () => {
  beforeEach(() => {
    sendMail.mockReset();
    sendMail.mockResolvedValue({});
  });

  it('sends mail with subject/to/from and a text+html body carrying the link', async () => {
    const ch = new EmailChannel({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      user: 'u',
      pass: 'p',
      from: 'bot@x',
      to: 'admin@x',
    });
    await ch.send(ctx);

    expect(sendMail).toHaveBeenCalledOnce();
    const mail = sendMail.mock.calls[0]![0];
    expect(mail.to).toBe('admin@x');
    expect(mail.from).toBe('bot@x');
    expect(mail.subject).toBe('New audiobook request');
    expect(mail.text).toContain('https://req.example.com/admin');
    expect(mail.html).toContain('Open the request queue');
  });

  it('labels the link per event — user.pending reads "Review pending users" and links to /users', async () => {
    const ch = new EmailChannel({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      user: 'u',
      pass: 'p',
      from: 'bot@x',
      to: 'admin@x',
    });
    await ch.send(userCtx);

    const mail = sendMail.mock.calls[0]![0];
    expect(mail.html).toContain('>Review pending users</a>');
    expect(mail.html).toContain('href="https://req.example.com/users"');
    expect(mail.html).not.toContain('Open the request queue');
  });

  it('HTML-escapes the linkLabel before inserting it into the anchor text', async () => {
    const ch = new EmailChannel({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      user: 'u',
      pass: 'p',
      from: 'bot@x',
      to: 'admin@x',
    });
    await ch.send({
      payload: ctx.payload,
      message: { ...ctx.message, linkLabel: 'Review <b>"all" & more</b>' },
    });

    const mail = sendMail.mock.calls[0]![0];
    expect(mail.html).toContain('Review &lt;b&gt;&quot;all&quot; &amp; more&lt;/b&gt;');
    expect(mail.html).not.toContain('<b>');
  });

  it('HTML-escapes message.url before inserting it into the href (no attribute breakout)', async () => {
    const ch = new EmailChannel({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      user: 'u',
      pass: 'p',
      from: 'bot@x',
      to: 'admin@x',
    });
    await ch.send({
      payload: ctx.payload,
      message: { ...ctx.message, url: 'https://req.example.com/admin?a=1&b=2"x' },
    });

    const mail = sendMail.mock.calls[0]![0];
    expect(mail.html).toContain('href="https://req.example.com/admin?a=1&amp;b=2&quot;x"');
    // A raw quote would close the href attribute early — assert it never reaches the markup.
    expect(mail.html).not.toContain('b=2"x');
  });

  it('omits the link and uses the plain body as text when message.url is null', async () => {
    const ch = new EmailChannel({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      user: 'u',
      pass: 'p',
      from: 'bot@x',
      to: 'admin@x',
    });
    await ch.send({ payload: ctx.payload, message: { ...ctx.message, url: null } });

    const mail = sendMail.mock.calls[0]![0];
    expect(mail.html).not.toContain('<a');
    expect(mail.text).toBe(ctx.message.body);
  });

  it('propagates a sendMail rejection so the dispatcher can log it', async () => {
    sendMail.mockRejectedValueOnce(new Error('smtp down'));
    const ch = new EmailChannel({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      user: 'u',
      pass: 'p',
      from: 'bot@x',
      to: 'admin@x',
    });
    await expect(ch.send(ctx)).rejects.toThrow(/smtp down/);
  });

  it('builds the transport without an auth block when user/pass are absent', () => {
    createTransport.mockClear();
    new EmailChannel({
      host: 'smtp.example.com',
      port: 25,
      secure: false,
      user: null,
      pass: null,
      from: 'bot@x',
      to: 'admin@x',
    });

    expect(createTransport).toHaveBeenCalledOnce();
    const opts = createTransport.mock.calls[0]![0];
    expect(opts).not.toHaveProperty('auth');
  });
});

// ---- Parity-pack adapters (Discord / Slack / Telegram / Pushover / Gotify) ----
// Each is exercised for BOTH events, asserts the outbound URL/headers/body shape, throws
// on a non-2xx, and bounds the call with an AbortSignal.

/** Stub fetch returning 200 for a describe block; returns the mock for per-test overrides. */
function stubFetch(status = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('DiscordChannel', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = stubFetch(204);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('POSTs an embed with allowed_mentions:{parse:[]}, a thumbnail when includeCover + a cover, and a timeout signal', async () => {
    const ch = new DiscordChannel({ webhookUrl: 'https://discord.com/api/webhooks/1/abc', includeCover: true });
    await ch.send(ctx);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://discord.com/api/webhooks/1/abc');
    expect(init.method).toBe('POST');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(init.body);
    expect(body.allowed_mentions).toEqual({ parse: [] });
    const embed = body.embeds[0];
    expect(embed.title).toBe('New audiobook request');
    expect(embed.description).toContain('Dune');
    expect(embed.url).toBe('https://req.example.com/admin');
    expect(embed.thumbnail).toEqual({ url: 'https://x/c.jpg' });
    expect(embed.footer).toEqual({ text: 'narratorr-requests' });
  });

  it('always sends allowed_mentions even on a user.pending event (no thumbnail, no cover)', async () => {
    const ch = new DiscordChannel({ webhookUrl: 'https://discord.com/api/webhooks/1/abc', includeCover: true });
    await ch.send(userCtx);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.embeds[0].thumbnail).toBeUndefined();
  });

  it('omits the thumbnail when includeCover is false even if a cover exists', async () => {
    const ch = new DiscordChannel({ webhookUrl: 'https://discord.com/api/webhooks/1/abc', includeCover: false });
    await ch.send(ctx);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).embeds[0].thumbnail).toBeUndefined();
  });

  it('truncates an over-limit title to 256 and description to 4096 chars', async () => {
    const ch = new DiscordChannel({ webhookUrl: 'https://discord.com/api/webhooks/1/abc', includeCover: true });
    await ch.send({
      payload: ctx.payload,
      message: { ...ctx.message, title: 'x'.repeat(300), body: 'y'.repeat(5000) },
    });
    const embed = JSON.parse(fetchMock.mock.calls[0]![1].body).embeds[0];
    expect(embed.title).toHaveLength(256);
    expect(embed.description).toHaveLength(4096);
  });

  it('throws on a non-2xx response', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 400 }));
    const ch = new DiscordChannel({ webhookUrl: 'https://discord.com/api/webhooks/1/abc', includeCover: true });
    await expect(ch.send(ctx)).rejects.toThrow(/400/);
  });

  it('colours a request.failed embed with its own EVENT_COLOR and attaches the cover', async () => {
    const ch = new DiscordChannel({ webhookUrl: 'https://discord.com/api/webhooks/1/abc', includeCover: true });
    await ch.send(failedCtx);
    const embed = JSON.parse(fetchMock.mock.calls[0]![1].body).embeds[0];
    expect(embed.title).toBe('Request failed');
    expect(embed.color).toBe(0xe74c3c); // request.failed entry, NOT the default blue
    expect(embed.thumbnail).toEqual({ url: 'https://x/c.jpg' }); // cover attaches via 'request' in payload
  });
});

describe('SlackChannel', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = stubFetch(200);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('POSTs a bold-title text block with the link, bounded by a timeout', async () => {
    const ch = new SlackChannel({ webhookUrl: 'https://hooks.slack.com/services/x' });
    await ch.send(ctx);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://hooks.slack.com/services/x');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(init.body);
    expect(body.text).toContain('*New audiobook request*');
    expect(body.text).toContain('https://req.example.com/admin');
  });

  it('delivers a user.pending event', async () => {
    const ch = new SlackChannel({ webhookUrl: 'https://hooks.slack.com/services/x' });
    await ch.send(userCtx);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).text).toContain('New user awaiting approval');
  });

  it('escapes &/</> in user-supplied content (no raw injection)', async () => {
    const ch = new SlackChannel({ webhookUrl: 'https://hooks.slack.com/services/x' });
    await ch.send({ payload: ctx.payload, message: { ...ctx.message, body: 'A <b> & <c> @everyone' } });
    const text = JSON.parse(fetchMock.mock.calls[0]![1].body).text;
    expect(text).toContain('&lt;b&gt; &amp; &lt;c&gt;');
    expect(text).not.toContain('<b>');
  });

  it('throws on a non-2xx response', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 500 }));
    const ch = new SlackChannel({ webhookUrl: 'https://hooks.slack.com/services/x' });
    await expect(ch.send(ctx)).rejects.toThrow(/500/);
  });
});

describe('TelegramChannel', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = stubFetch(200);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('POSTs to the bot sendMessage URL with chat_id + HTML parse mode, bounded by a timeout', async () => {
    const ch = new TelegramChannel({ botToken: '123:secret', chatId: '-42' });
    await ch.send(ctx);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.telegram.org/bot123:secret/sendMessage');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(init.body);
    expect(body.chat_id).toBe('-42');
    expect(body.parse_mode).toBe('HTML');
    expect(body.text).toContain('<b>New audiobook request</b>');
    expect(body.text).toContain('https://req.example.com/admin');
  });

  it('delivers a user.pending event', async () => {
    const ch = new TelegramChannel({ botToken: '123:secret', chatId: '-42' });
    await ch.send(userCtx);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).text).toContain('<b>New user awaiting approval</b>');
  });

  it('HTML-escapes user-supplied content (no raw tag injection)', async () => {
    const ch = new TelegramChannel({ botToken: '123:secret', chatId: '-42' });
    await ch.send({ payload: ctx.payload, message: { ...ctx.message, body: '<i>x</i> & @everyone' } });
    const text = JSON.parse(fetchMock.mock.calls[0]![1].body).text;
    expect(text).toContain('&lt;i&gt;x&lt;/i&gt; &amp;');
    expect(text).not.toContain('<i>');
  });

  it('throws on a non-2xx response', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    const ch = new TelegramChannel({ botToken: '123:secret', chatId: '-42' });
    await expect(ch.send(ctx)).rejects.toThrow(/401/);
  });
});

describe('PushoverChannel', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = stubFetch(200);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('POSTs token/user/title/message with priority 0 to the fixed host, bounded by a timeout', async () => {
    const ch = new PushoverChannel({ appToken: 'app-tok', userKey: 'user-key' });
    await ch.send(ctx);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.pushover.net/1/messages.json');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ token: 'app-tok', user: 'user-key', title: 'New audiobook request', priority: 0 });
    expect(body.message).toContain('https://req.example.com/admin');
  });

  it('delivers a user.pending event', async () => {
    const ch = new PushoverChannel({ appToken: 'app-tok', userKey: 'user-key' });
    await ch.send(userCtx);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).title).toBe('New user awaiting approval');
  });

  it('truncates title to 250 and message to 1024', async () => {
    const ch = new PushoverChannel({ appToken: 'app-tok', userKey: 'user-key' });
    await ch.send({
      payload: ctx.payload,
      message: { title: 'T'.repeat(300), body: 'B'.repeat(2000), url: null, linkLabel: 'Open the request queue' },
    });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.title).toHaveLength(250);
    expect(body.message).toHaveLength(1024);
  });

  it('throws on a non-2xx response', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 429 }));
    const ch = new PushoverChannel({ appToken: 'app-tok', userKey: 'user-key' });
    await expect(ch.send(ctx)).rejects.toThrow(/429/);
  });
});

describe('GotifyChannel', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = stubFetch(200);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('POSTs to <serverUrl>/message with the X-Gotify-Key header + priority 5, bounded by a timeout', async () => {
    const ch = new GotifyChannel({ serverUrl: 'https://gotify.example.com', appToken: 'g-tok' });
    await ch.send(ctx);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://gotify.example.com/message');
    expect(init.headers['X-Gotify-Key']).toBe('g-tok');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ title: 'New audiobook request', priority: 5 });
    expect(body.message).toContain('https://req.example.com/admin');
  });

  it('normalizes a trailing slash on the server URL', async () => {
    const ch = new GotifyChannel({ serverUrl: 'https://gotify.example.com///', appToken: 'g-tok' });
    await ch.send(userCtx);
    expect(fetchMock.mock.calls[0]![0]).toBe('https://gotify.example.com/message');
  });

  it('throws on a non-2xx response', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 403 }));
    const ch = new GotifyChannel({ serverUrl: 'https://gotify.example.com', appToken: 'g-tok' });
    await expect(ch.send(ctx)).rejects.toThrow(/403/);
  });
});

// ---- Redirect hardening (#199) ----
// A destination that answers a 30x must not get the request re-issued at the host IT named:
// the WHATWG cross-origin stripping rule covers `Authorization` only, so gotify's custom
// X-Gotify-Key would ride along, and a 307/308 replays the pushover body verbatim.

describe('fetch adapters — redirect hardening (#199)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = stubFetch(200);
  });
  afterEach(() => vi.unstubAllGlobals());

  // Exhaustive over every non-email notifier type: `email` is SMTP (nodemailer), not fetch.
  // The Record type is the point — a new entry in NOTIFIER_TYPES fails typecheck here until
  // its adapter gets a redirect assertion, so this block is the ONE owner of the claim (the
  // per-adapter outbound-shape tests above deliberately do not duplicate it).
  const FETCH_CHANNELS: Record<Exclude<NotifierType, 'email'>, NotificationChannel> = {
    ntfy: new NtfyChannel({ url: 'https://ntfy.sh', topic: 'narr', token: 'tok', priority: null }),
    webhook: new WebhookChannel({ url: 'https://hook.example.com/x' }),
    discord: new DiscordChannel({ webhookUrl: 'https://discord.com/api/webhooks/1/abc', includeCover: true }),
    slack: new SlackChannel({ webhookUrl: 'https://hooks.slack.com/services/x' }),
    telegram: new TelegramChannel({ botToken: '123:secret', chatId: '-42' }),
    pushover: new PushoverChannel({ appToken: 'app-tok', userKey: 'user-key' }),
    gotify: new GotifyChannel({ serverUrl: 'https://gotify.example.com', appToken: 'g-tok' }),
  };

  it.each(Object.entries(FETCH_CHANNELS))(
    '%s passes redirect:"error" (and keeps its timeout signal) in the fetch init',
    async (_type, ch) => {
      await ch.send(ctx);

      const init = fetchMock.mock.calls[0]![1];
      expect(init.redirect).toBe('error');
      // Asserted in the same test so a future edit cannot trade one option away for the other.
      expect(init.signal).toBeInstanceOf(AbortSignal);
    },
  );
});

// ---------------------------------------------------------------------------
// Real-socket harness. `redirect: 'error'` is only meaningful to a real HTTP client over a
// real socket — an in-process fetch stub makes correct and broken code behave identically
// (learning `msw-cannot-test-body-read-abort`, #95). This file uses no MSW, so the
// close/re-arm dance that narratorr-client.test.ts needs does not apply; the blocks below
// just leave `fetch` unstubbed.
// ---------------------------------------------------------------------------

interface RecordedRequest {
  url: string;
  headers: IncomingHttpHeaders;
}

interface RecordingServer {
  baseUrl: string;
  /** Every request this server saw — the credential-replay detector. */
  requests: RecordedRequest[];
  close(): Promise<void>;
}

async function startRecordingServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<RecordingServer> {
  const requests: RecordedRequest[] = [];
  const s = createServer((req, res) => {
    requests.push({ url: req.url ?? '', headers: req.headers });
    // A client that walks away mid-response makes the socket error (EPIPE/ECONNRESET) — swallow
    // it so a hardening test can't take the whole worker down with an unhandled 'error'.
    res.on('error', () => {});
    req.on('error', () => {});
    handler(req, res);
  });
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', () => resolve()));
  const { port } = s.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: async () => {
      s.closeAllConnections(); // undici pools keep-alive sockets; without this `close` hangs
      await new Promise<void>((resolve) => s.close(() => resolve()));
    },
  };
}

describe('GotifyChannel — redirect hardening over real sockets (#199)', () => {
  // Defensive: an earlier describe's stubbed fetch must never bleed into these tests.
  beforeEach(() => vi.unstubAllGlobals());

  // 302 is the filed status (header replay); 307 additionally replays a POST body verbatim,
  // so the pair covers both mechanisms. The option is not status-conditional, so pinning all
  // five here would be redundant — narratorr-client.test.ts already pins the full set.
  it.each([302, 307])(
    'does NOT follow a %d — the app token never reaches the host the destination named',
    async (status) => {
      const target = await startRecordingServer((_req, res) => {
        res.writeHead(200);
        res.end();
      });
      const redirector = await startRecordingServer((_req, res) => {
        res.writeHead(status, { location: `${target.baseUrl}/message` });
        res.end();
      });
      try {
        const ch = new GotifyChannel({ serverUrl: redirector.baseUrl, appToken: 'g-tok' });

        // Type only — the runtime owns the message/cause text and may change it (AC5). A
        // `Gotify responded 200` here would instead mean the redirect WAS followed.
        await expect(ch.send(ctx)).rejects.toBeInstanceOf(TypeError);
        expect(target.requests).toEqual([]);
        // Stated over the recorded requests so the claim is about the credential, not the count.
        expect(target.requests.filter((r) => r.headers['x-gotify-key'] !== undefined)).toEqual([]);
        // Vacuity guard — without it the test would also pass if nothing was ever sent.
        expect(redirector.requests).toHaveLength(1);
      } finally {
        await redirector.close();
        await target.close();
      }
    },
  );

  it('does not normalize a non-redirect 3xx — a 300 carrying a Location keeps its real status', async () => {
    const target = await startRecordingServer((_req, res) => {
      res.writeHead(200);
      res.end();
    });
    // A Location header on a NON-redirect status separates "has a Location" from "is a
    // redirect status" — 300 was never followed, before or after this change.
    const server = await startRecordingServer((_req, res) => {
      res.writeHead(300, { location: `${target.baseUrl}/message` });
      res.end();
    });
    try {
      const ch = new GotifyChannel({ serverUrl: server.baseUrl, appToken: 'g-tok' });
      await expect(ch.send(ctx)).rejects.toThrow(/300/);
      expect(target.requests).toEqual([]);
    } finally {
      await server.close();
      await target.close();
    }
  });
});
