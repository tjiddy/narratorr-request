import { z } from 'zod';
import { DEFAULT_LIMIT, MAX_LIMIT } from './v1/common.js';

// =============================================================================
// coverUrl SSRF guard. A request-supplied coverUrl is rendered as <img src> in
// the admin's browser and forwarded as ntfy's `Icon` header (the ntfy server
// then fetches it) — both are server-/admin-initiated loads of an arbitrary URL.
// The schema is the sole guard, so it enforces https + a non-internal host. We
// parse with new URL() (a built-in; no IP library) and reject loopback, RFC-1918
// / RFC-4193 ULA private, link-local (incl. 169.254.169.254 cloud-metadata), the
// special-use `localhost` name family, and internal IPv4 embedded in IPv6
// literals (IPv4-mapped + deprecated IPv4-compatible). Alternate IPv4 encodings
// (decimal/hex/octal/short) need no special handling — the WHATWG parser
// canonicalizes them into dotted-decimal `.hostname`, so the range check catches
// them. NAT64 (64:ff9b::/96) is treated as a normal public host (not rejected).
// Known residual gap, NOT closed here: DNS rebinding — a public hostname that
// passes validation and later resolves to an internal IP at fetch time.
// =============================================================================

/** Internal (loopback / private / link-local / unspecified) IPv4, from octets. */
function isInternalIpv4(octets: readonly [number, number, number, number]): boolean {
  const [a, b] = octets;
  if (a === 0) return true; // 0.0.0.0/8 (incl. 0.0.0.0)
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
  return false;
}

/** Parse a dotted-decimal IPv4 string into four octets, or null if not one. */
function parseIpv4(s: string): [number, number, number, number] | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  if (octets.some((o) => Number.isNaN(o) || o > 255)) return null;
  return octets as [number, number, number, number];
}

/** Expand an IPv6 literal (brackets stripped) into its eight 16-bit groups, or null. */
function expandIpv6(raw: string): number[] | null {
  let s = raw;
  // A trailing dotted-IPv4 tail (e.g. ::ffff:127.0.0.1) → two hex groups, so the
  // expander below sees a uniform colon-separated form.
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIpv4(tail);
    if (!v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    s = `${s.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const toGroups = (part: string): number[] =>
    part === '' ? [] : part.split(':').map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN));
  let groups: number[];
  if (halves.length === 2) {
    const head = toGroups(halves[0] ?? '');
    const rest = toGroups(halves[1] ?? '');
    const fill = 8 - head.length - rest.length;
    if (fill < 0) return null;
    groups = [...head, ...(Array(fill).fill(0) as number[]), ...rest];
  } else {
    groups = toGroups(s);
  }
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g))) return null;
  return groups;
}

/** Internal IPv6: loopback/unspecified/ULA/link-local, or internal IPv4 embedded in a v6 literal. */
function isInternalIpv6(groups: readonly number[]): boolean {
  const g0 = groups[0] ?? 0;
  const embeddedV4 = (): [number, number, number, number] => {
    const g6 = groups[6] ?? 0;
    const g7 = groups[7] ?? 0;
    return [g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff];
  };
  if (groups.every((g) => g === 0)) return true; // :: unspecified
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true; // ::1 loopback
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  // ::ffff:0:0/96 IPv4-mapped and ::/96 deprecated IPv4-compatible — check the embedded IPv4.
  const isMapped = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
  const isCompat = groups.slice(0, 6).every((g) => g === 0);
  if (isMapped || isCompat) return isInternalIpv4(embeddedV4());
  return false;
}

/** True if the URL hostname is an internal host we must not let through. */
function isInternalHost(hostname: string): boolean {
  // hostname is already lowercased by the URL parser. localhost family (RFC 6761
  // §6.3): strip a single trailing dot, then reject `localhost` / `*.localhost`.
  const name = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
  if (name === 'localhost' || name.endsWith('.localhost')) return true;
  // IPv6 literals serialize bracketed ([::1]); strip the brackets before parsing.
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    const groups = expandIpv6(hostname.slice(1, -1));
    return groups ? isInternalIpv6(groups) : true; // unparseable v6 → reject
  }
  const v4 = parseIpv4(hostname);
  if (v4) return isInternalIpv4(v4);
  return false; // a regular DNS name — public (DNS rebinding is a known residual gap)
}

/** https scheme + non-internal host. Unparseable input fails the refine (never throws).
 *  Exported so the client can pre-drop a non-conforming cover instead of failing the create. */
export function isPublicHttpsUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  return !isInternalHost(url.hostname);
}

// =============================================================================
// Request lifecycle (this app's domain). Maps onto Narratorr's book status:
//   pending --approve--> approved --handoff(POST /books)--> acquiring
//   --poll(GET /books/:id imported)--> available
//   denied / failed are terminal.
// =============================================================================
export const REQUEST_STATUSES = [
  'pending',
  'approved',
  'denied',
  'acquiring',
  'available',
  'failed',
] as const;
export const requestStatusSchema = z.enum(REQUEST_STATUSES);
export type RequestStatus = z.infer<typeof requestStatusSchema>;

/**
 * "Open" = still occupying a quota slot and still de-duplicated against new
 * requests for the same book. `failed` is excluded here (refunded) — a failed
 * request never counts toward quota.
 */
export const OPEN_REQUEST_STATUSES = ['pending', 'approved', 'acquiring', 'available'] as const;

/** Statuses that block a duplicate open request for the same (user, asin). */
export const ACTIVE_REQUEST_STATUSES = ['pending', 'approved', 'acquiring'] as const;

/**
 * The admin queue's "Approved" filter spans the whole post-approval lifecycle, not just
 * the transient `approved` row: once approved, a request moves approved → acquiring →
 * available within a poll tick, so an exact-status match would read ~empty. This is the
 * set an admin means by "requests I've approved".
 */
export const APPROVED_REQUEST_STATUSES = ['approved', 'acquiring', 'available'] as const;

// Snapshot fields are denormalized onto the request at create time so the queue
// renders even if the upstream catalog entry changes or disappears.
export const createRequestBodySchema = z
  .object({
    asin: z.string().trim().min(1),
    title: z.string().trim().min(1),
    author: z.string().trim().nullish(),
    narrator: z.string().trim().nullish(),
    // SSRF guard (see isPublicHttpsUrl above): require an https scheme AND a
    // non-internal host — rejecting loopback/private/link-local IPs, the
    // `localhost` name family, and internal IPv4 embedded in IPv6 literals.
    // .trim() runs first so whitespace never reaches new URL(). DNS rebinding (a
    // public name that later resolves internal at fetch time) is a known residual
    // gap not closed here.
    coverUrl: z.string().trim().refine(isPublicHttpsUrl, 'coverUrl must be a public https URL').nullish(),
    note: z.string().trim().max(500).nullish(),
  })
  .strict();
export type CreateRequestBody = z.infer<typeof createRequestBodySchema>;

// Admin approve/deny.
export const decisionBodySchema = z
  .object({
    action: z.enum(['approve', 'deny']),
    note: z.string().trim().max(500).nullish(),
  })
  .strict();
export type DecisionBody = z.infer<typeof decisionBodySchema>;

// The page-size default is single-sourced from common.ts (DEFAULT_LIMIT) and applied
// HERE, so a list request that omits `limit`/`offset` parses to the 50/0 default and the
// routes no longer carry their own fallback constants. `limit` stays bounded at MAX_LIMIT.
export const requestListQuerySchema = z.object({
  status: requestStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
});
export type RequestListQuery = z.infer<typeof requestListQuerySchema>;

// Shape returned to the client. `requester` is included for the admin queue;
// `status` is the live request status the poller refreshes from the book.
export const requestDtoSchema = z.object({
  publicId: z.string(),
  asin: z.string(),
  title: z.string(),
  author: z.string().nullable(),
  narrator: z.string().nullable(),
  coverUrl: z.string().nullable(),
  status: requestStatusSchema,
  note: z.string().nullable(),
  // Why the request `failed` (e.g. an excluded edition, a vanished book). null unless
  // status is `failed`. Distinct from `note` (the request-time note / deny reason).
  failureReason: z.string().nullable(),
  requestedAt: z.string(),
  decidedAt: z.string().nullable(),
  narratorrBookId: z.string().nullable(),
  requester: z.object({ publicId: z.string(), username: z.string() }),
});
export type RequestDto = z.infer<typeof requestDtoSchema>;
