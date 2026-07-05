import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted so the mock factory can reference them (vi.mock is hoisted above imports). Mirrors the
// EmailChannel adapter test's nodemailer mock.
const { sendMail, createTransport } = vi.hoisted(() => {
  const sendMail = vi.fn();
  return { sendMail, createTransport: vi.fn((_opts?: unknown) => ({ sendMail })) };
});
vi.mock('nodemailer', () => ({
  default: { createTransport },
}));

import {
  selectEmailSource,
  renderRequesterMessage,
  RequesterEmailService,
} from './requester-email.js';
import type { NotificationsConfig, RuntimeNotifier } from './types.js';

/** A runtime email notifier with a full config; overrides tweak individual fields. */
const emailNotifier = (over: Partial<Record<string, unknown>> = {}, id = 'nf_email'): RuntimeNotifier => ({
  id,
  name: 'Mail',
  type: 'email',
  events: ['request.created'],
  config: { host: 'smtp.example.com', port: 587, secure: false, user: 'u', pass: 'p', from: 'ops@example.com', to: 'admin@example.com', ...over },
});

const cfg = (notifiers: RuntimeNotifier[], publicUrl: string | null = 'https://reqs.example.com'): NotificationsConfig => ({
  publicUrl,
  notifiers,
});

describe('selectEmailSource', () => {
  it('returns null when there is no email notifier', () => {
    expect(selectEmailSource(cfg([]))).toBeNull();
    const ntfy: RuntimeNotifier = { id: 'nf_n', name: 'n', type: 'ntfy', events: [], config: { url: 'x', topic: 't', token: null, priority: null } };
    expect(selectEmailSource(cfg([ntfy]))).toBeNull();
  });

  it('picks the FIRST usable email notifier in stored order (2+ email notifiers)', () => {
    const first = emailNotifier({ host: 'first.example.com' }, 'nf_1');
    const second = emailNotifier({ host: 'second.example.com' }, 'nf_2');
    expect(selectEmailSource(cfg([first, second]))?.host).toBe('first.example.com');
  });

  it('treats a passwordless / open-relay email notifier (user:null, pass:null) as usable', () => {
    const source = selectEmailSource(cfg([emailNotifier({ user: null, pass: null })]));
    expect(source).not.toBeNull();
    expect(source).toMatchObject({ user: null, pass: null });
  });

  it('skips a malformed/undecryptable first email notifier and falls through to the next valid one', () => {
    // A malformed row (missing host / wrong types) fails emailRuntimeSchema, same as a runtime
    // build throwing — degrade-and-continue to the next email row.
    const broken = emailNotifier({ host: 123 }, 'nf_broken');
    const valid = emailNotifier({ host: 'valid.example.com' }, 'nf_valid');
    expect(selectEmailSource(cfg([broken, valid]))?.host).toBe('valid.example.com');
  });

  it('returns null when the ONLY email notifier is malformed', () => {
    expect(selectEmailSource(cfg([emailNotifier({ port: 'not-a-number' })]))).toBeNull();
  });
});

describe('renderRequesterMessage (available)', () => {
  it('links to the requester’s own My Requests page, never an admin surface', () => {
    const msg = renderRequesterMessage('available', { title: 'Dune', author: 'Herbert' }, 'https://reqs.example.com');
    expect(msg.subject).toMatch(/ready/i);
    expect(msg.text).toContain('Dune');
    expect(msg.text).toContain('https://reqs.example.com/requests');
    expect(msg.html).toContain('href="https://reqs.example.com/requests"');
    expect(msg.text).not.toContain('/admin');
    expect(msg.html).not.toContain('/admin');
    expect(msg.html).not.toContain('/users');
  });

  it('omits the link when there is no public URL (no dead relative link)', () => {
    const msg = renderRequesterMessage('available', { title: 'Dune', author: null }, null);
    expect(msg.text).not.toContain('http');
    expect(msg.html).not.toContain('<a');
  });

  it('escapes interpolated values in the HTML body', () => {
    const msg = renderRequesterMessage('available', { title: 'A & B <x>', author: null }, null);
    expect(msg.html).toContain('A &amp; B &lt;x&gt;');
  });
});

describe('RequesterEmailService.send', () => {
  beforeEach(() => {
    sendMail.mockReset();
    sendMail.mockResolvedValue({});
    createTransport.mockClear();
  });

  it('builds the transport from the selected source and overrides `to` with the requester (never the admin to)', async () => {
    const svc = new RequesterEmailService(async () => cfg([emailNotifier({ host: 'smtp.pick.me', from: 'ops@pick.me', to: 'admin@pick.me' })]));
    await svc.send({ to: 'requester@example.com', transition: 'available', request: { title: 'Dune', author: 'Herbert' } });

    expect(createTransport).toHaveBeenCalledOnce();
    expect(createTransport.mock.calls[0]![0]).toMatchObject({ host: 'smtp.pick.me', port: 587, secure: false });
    expect(sendMail).toHaveBeenCalledOnce();
    const mail = sendMail.mock.calls[0]![0];
    expect(mail.to).toBe('requester@example.com'); // the requester, NOT the notifier's admin `to`
    expect(mail.from).toBe('ops@pick.me');
    expect(mail.subject).toMatch(/ready/i);
  });

  it('is a silent no-op when no usable email source exists (never throws, never sends)', async () => {
    const svc = new RequesterEmailService(async () => cfg([]));
    await expect(
      svc.send({ to: 'requester@example.com', transition: 'available', request: { title: 'Dune', author: null } }),
    ).resolves.toBeUndefined();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('omits the SMTP auth block for a passwordless source', async () => {
    const svc = new RequesterEmailService(async () => cfg([emailNotifier({ user: null, pass: null })]));
    await svc.send({ to: 'r@example.com', transition: 'available', request: { title: 'Dune', author: null } });
    expect(createTransport.mock.calls[0]![0]).not.toHaveProperty('auth');
  });
});
