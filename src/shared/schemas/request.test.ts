import { describe, it, expect } from 'vitest';
import { createRequestBodySchema, decisionBodySchema, requestListQuerySchema } from './request.js';
import { DEFAULT_LIMIT, MAX_LIMIT } from './v1/common.js';

describe('createRequestBodySchema', () => {
  const valid = { asin: 'B08GB58KD5', title: 'Project Hail Mary' };

  describe('coverUrl — https + non-internal-host SSRF guard', () => {
    // Security-sensitive rejects assert the offending path/code, not just `.success`,
    // so a sibling-field regression (e.g. asin/title breaking) can't make a coverUrl
    // negative test pass for the wrong reason. The guard is a .refine() → `custom` code.
    const rejectsAt = (coverUrl: unknown) => {
      const result = createRequestBodySchema.safeParse({ ...valid, coverUrl });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(['coverUrl']);
      expect(result.error?.issues[0]?.code).toBe('custom');
    };

    it('accepts a normal public https url and round-trips the value', () => {
      const url = 'https://public.example.com/cover.jpg';
      const parsed = createRequestBodySchema.parse({ ...valid, coverUrl: url });
      expect(parsed.coverUrl).toBe(url);
    });

    it('accepts and trims a public https url with surrounding whitespace', () => {
      const parsed = createRequestBodySchema.parse({ ...valid, coverUrl: '  https://public.example.com/cover.jpg  ' });
      expect(parsed.coverUrl).toBe('https://public.example.com/cover.jpg');
    });

    it('accepts a public IPv4 literal host (the non-internal-IPv4 branch)', () => {
      // Every other IP case rejects; this pins the accept side. 8.8.8.8 is plainly public,
      // and 172.15.0.1 / 172.32.0.1 sit just outside the 172.16.0.0/12 private range — so
      // all three must pass (isInternalIpv4 → false) without over-blocking a legit public IP.
      for (const url of ['https://8.8.8.8/cover.jpg', 'https://172.15.0.1/c.png', 'https://172.32.0.1/c.png']) {
        expect(createRequestBodySchema.parse({ ...valid, coverUrl: url }).coverUrl).toBe(url);
      }
    });

    it('rejects non-https schemes (http, javascript, data)', () => {
      for (const coverUrl of [
        'http://public.example.com',
        'javascript:alert(1)',
        'data:image/png;base64,AAAA',
      ]) {
        rejectsAt(coverUrl);
      }
    });

    it('rejects after trim — surrounding whitespace cannot smuggle an http url past the guard', () => {
      // .trim() runs before the refine, so this trims to 'http://evil' and must fail on scheme.
      rejectsAt('  http://evil  ');
    });

    it('rejects IPv4 loopback / private / link-local hosts', () => {
      for (const coverUrl of [
        'https://127.0.0.1',
        'https://0.0.0.0',
        'https://10.0.0.1',
        'https://172.16.0.1',
        'https://192.168.0.22',
        'https://169.254.169.254', // cloud-metadata
      ]) {
        rejectsAt(coverUrl);
      }
    });

    it('rejects alternate IPv4 encodings the URL parser normalizes to an internal host', () => {
      // These pass because WHATWG `new URL()` canonicalizes each form to dotted-decimal
      // before our code sees `.hostname`; `parseIpv4` has no fallback for these forms and
      // would return null (→ treated as a *public* host). So a future host-parser regression
      // that stopped normalizing them would flip these to *accept* and fail here — the
      // intended tripwire for a reachable-internal SSRF bypass.
      for (const coverUrl of [
        'https://2130706433/', // decimal  → 127.0.0.1
        'https://0x7f000001/', // hex      → 127.0.0.1
        'https://0177.0.0.1/', // octal    → 127.0.0.1
        'https://127.1/', // short    → 127.0.0.1
        'https://10.0xff.0.1/', // mixed    → 10.255.0.1
      ]) {
        rejectsAt(coverUrl);
      }
    });

    it('rejects the localhost name family (localhost, trailing dot, *.localhost)', () => {
      for (const coverUrl of ['https://localhost', 'https://localhost./', 'https://anything.localhost/']) {
        rejectsAt(coverUrl);
      }
    });

    it('rejects IPv6 loopback / ULA / link-local (bracketed hostname normalization)', () => {
      for (const coverUrl of ['https://[::1]', 'https://[fd00::1]', 'https://[fe80::1]']) {
        rejectsAt(coverUrl);
      }
    });

    it('rejects IPv4-embedded IPv6 literals carrying an internal IPv4', () => {
      for (const coverUrl of [
        'https://[::ffff:127.0.0.1]/', // IPv4-mapped → [::ffff:7f00:1]
        'https://[::ffff:192.168.0.22]/',
        'https://[::ffff:169.254.169.254]/',
        'https://[::127.0.0.1]/', // deprecated IPv4-compatible → [::7f00:1]
      ]) {
        rejectsAt(coverUrl);
      }
    });

    it('accepts a public IPv6 literal', () => {
      expect(createRequestBodySchema.safeParse({ ...valid, coverUrl: 'https://[2606:4700:4700::1111]/' }).success).toBe(true);
    });

    it('rejects a non-empty but unparseable url instead of throwing', () => {
      rejectsAt('https://');
    });

    it('accepts null and absent (.nullish())', () => {
      expect(createRequestBodySchema.safeParse({ ...valid, coverUrl: null }).success).toBe(true);
      expect(createRequestBodySchema.safeParse(valid).success).toBe(true);
    });
  });

  describe('asin / title — trim + min(1)', () => {
    it('rejects empty and whitespace-only values', () => {
      expect(createRequestBodySchema.safeParse({ ...valid, asin: '' }).success).toBe(false);
      expect(createRequestBodySchema.safeParse({ ...valid, asin: '   ' }).success).toBe(false);
      expect(createRequestBodySchema.safeParse({ ...valid, title: '' }).success).toBe(false);
      expect(createRequestBodySchema.safeParse({ ...valid, title: '   ' }).success).toBe(false);
    });

    it('trims surrounding whitespace on a valid value', () => {
      const parsed = createRequestBodySchema.parse({ asin: '  B08GB58KD5  ', title: '  Project Hail Mary  ' });
      expect(parsed.asin).toBe('B08GB58KD5');
      expect(parsed.title).toBe('Project Hail Mary');
    });
  });

  describe('note — max(500)', () => {
    it('accepts a 500-char note and rejects 501', () => {
      expect(createRequestBodySchema.safeParse({ ...valid, note: 'x'.repeat(500) }).success).toBe(true);
      expect(createRequestBodySchema.safeParse({ ...valid, note: 'x'.repeat(501) }).success).toBe(false);
    });

    it('accepts null and absent (.nullish())', () => {
      expect(createRequestBodySchema.safeParse({ ...valid, note: null }).success).toBe(true);
      expect(createRequestBodySchema.safeParse(valid).success).toBe(true);
    });
  });

  describe('.strict()', () => {
    it('rejects an unknown key', () => {
      expect(createRequestBodySchema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
    });
  });
});

describe('requestListQuerySchema — single-sourced default + bounds (AC3)', () => {
  it('applies the shared DEFAULT_LIMIT / offset 0 when omitted', () => {
    const parsed = requestListQuerySchema.parse({});
    expect(parsed.limit).toBe(DEFAULT_LIMIT);
    expect(parsed.offset).toBe(0);
    expect(parsed.status).toBeUndefined();
  });

  it('round-trips an explicit limit/offset — including offset 0', () => {
    expect(requestListQuerySchema.parse({ limit: 5, offset: 2 })).toMatchObject({ limit: 5, offset: 2 });
    expect(requestListQuerySchema.parse({ limit: 10, offset: 0 }).offset).toBe(0);
  });

  it('coerces string inputs (querystring values) to numbers', () => {
    const parsed = requestListQuerySchema.parse({ limit: '25', offset: '100' });
    expect(parsed).toMatchObject({ limit: 25, offset: 100 });
  });

  it('accepts the status filter', () => {
    expect(requestListQuerySchema.parse({ status: 'pending' }).status).toBe('pending');
    expect(requestListQuerySchema.safeParse({ status: 'bogus' }).success).toBe(false);
  });

  it('rejects out-of-range paging: limit 0, limit > MAX_LIMIT, negative offset', () => {
    expect(requestListQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(requestListQuerySchema.safeParse({ limit: MAX_LIMIT + 1 }).success).toBe(false);
    expect(requestListQuerySchema.safeParse({ offset: -1 }).success).toBe(false);
    // The MAX_LIMIT boundary itself is accepted.
    expect(requestListQuerySchema.parse({ limit: MAX_LIMIT }).limit).toBe(MAX_LIMIT);
  });
});

describe('decisionBodySchema', () => {
  describe('action enum', () => {
    it('accepts approve and deny', () => {
      expect(decisionBodySchema.safeParse({ action: 'approve' }).success).toBe(true);
      expect(decisionBodySchema.safeParse({ action: 'deny' }).success).toBe(true);
    });

    it('rejects anything else (case-sensitive, empty, missing)', () => {
      expect(decisionBodySchema.safeParse({ action: 'reject' }).success).toBe(false);
      expect(decisionBodySchema.safeParse({ action: 'APPROVE' }).success).toBe(false);
      expect(decisionBodySchema.safeParse({ action: '' }).success).toBe(false);
      expect(decisionBodySchema.safeParse({}).success).toBe(false);
    });
  });

  describe('note — max(500)', () => {
    it('accepts a 500-char note and rejects 501', () => {
      expect(decisionBodySchema.safeParse({ action: 'approve', note: 'x'.repeat(500) }).success).toBe(true);
      expect(decisionBodySchema.safeParse({ action: 'approve', note: 'x'.repeat(501) }).success).toBe(false);
    });
  });

  describe('.strict()', () => {
    it('rejects an unknown key', () => {
      expect(decisionBodySchema.safeParse({ action: 'approve', extra: 1 }).success).toBe(false);
    });
  });
});
