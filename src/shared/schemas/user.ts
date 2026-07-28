import { z } from 'zod';
import { quotaLimitSchema, quotaWindowDaysSchema } from './connectors.js';

// Roles this app owns. MVP auto-approves admins only (PLAN decision #5); a
// "trusted" role can be added later without a migration churn.
export const USER_ROLES = ['admin', 'user'] as const;
export const roleSchema = z.enum(USER_ROLES);
export type Role = z.infer<typeof roleSchema>;

// Account approval state, ORTHOGONAL to role. A new user authenticates but lands
// `pending` and can't request until an admin approves. `rejected` is a durable
// denial (survives re-login — never silently re-opens). Admins are always treated
// as active. The first user in any auth method is created active (+ admin).
export const USER_STATUSES = ['pending', 'active', 'rejected'] as const;
export const userStatusSchema = z.enum(USER_STATUSES);
export type UserStatus = z.infer<typeof userStatusSchema>;

// Per-user request-quota override as an explicit POLICY MODE (discriminated union), NOT an
// overloaded `number | null`. The four modes are first-class admin intentions:
//   • inherit   — no override; fall back to the app default.
//   • unlimited — no cap for this user, even if the default is limited.
//   • limited   — a per-user positive cap (rides the global rolling window).
//   • blocked   — a hard admin block, distinct from "a cap of 0" (→ 403 QUOTA_BLOCKED).
// Reused as BOTH the read shape (`userDtoSchema.requestQuota`) and the PATCH body field, so the
// mode-first editor loads existing state, not just saves it. A never-overridden user reads `inherit`.
export const requestQuotaSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('inherit') }),
  z.strictObject({ mode: z.literal('unlimited') }),
  z.strictObject({ mode: z.literal('limited'), limit: quotaLimitSchema }),
  z.strictObject({ mode: z.literal('blocked') }),
]);
export type RequestQuota = z.infer<typeof requestQuotaSchema>;
export const REQUEST_QUOTA_MODES = ['inherit', 'unlimited', 'limited', 'blocked'] as const;
export type RequestQuotaMode = (typeof REQUEST_QUOTA_MODES)[number];

// --- Requester notification opt-in -------------------------------------------
// The transitions a requester can opt into being emailed about. A DEDICATED const — NOT
// the 6-value RequestStatus — because only transitions with a real emit site belong here
// (pending/acquiring never email anyone, so reusing RequestStatus would ship checkboxes
// that can never fire). This is the single source of truth for the opt-in Zod schema, the
// client control, and emit-site coverage. Ordered approved → denied → available to match the
// request lifecycle: each entry has a live emit site (decision-time sends in
// `RequestService.decide`, availability via the poller sweep), so the const never lists a
// transition that can't fire (issues #50, #131). `renderRequesterMessage`'s exhaustiveness
// guard forces copy for every entry here at compile time.
export const NOTIFIABLE_TRANSITIONS = ['approved', 'denied', 'available'] as const;
export type NotifiableTransition = (typeof NOTIFIABLE_TRANSITIONS)[number];
export const notifiableTransitionSchema = z.enum(NOTIFIABLE_TRANSITIONS);

/**
 * Narrow a stored/legacy `notify_on` JSON value into a clean `NotifiableTransition[]`. A
 * corrupt / hand-edited / legacy blob (non-array, or an entry outside the current const)
 * DEGRADES TO EMPTY rather than throwing — mirroring the `autoApproveRoles`/`connectors`
 * degrade-and-continue discipline (a bad opt-in must never brick a read or a send). Duplicate
 * values are collapsed. Pure, so it's shared by the DB read path, the DTO, and the client.
 */
export function sanitizeNotifyOn(raw: unknown): NotifiableTransition[] {
  const parsed = z.array(notifiableTransitionSchema).safeParse(raw);
  if (!parsed.success) return [];
  return [...new Set(parsed.data)];
}

/**
 * Whether a stored/legacy `notify_on` value represents ANY real opt-in — true iff
 * {@link sanitizeNotifyOn} yields a non-empty set (so a corrupt/legacy value outside the const,
 * or `'[]'`, is `false`). The SINGLE authoritative opt-in-existence predicate: the admin
 * "requester emails enabled but no source" warning decides "has anyone opted in?" with THIS, and
 * the send path derives its per-transition decision from the same {@link sanitizeNotifyOn} +
 * `NOTIFIABLE_TRANSITIONS`, so the warning can't drift from whether a send would fire. Kept
 * transition-agnostic on purpose — the `available` sweep tests `sanitizeNotifyOn(...).includes('available')`
 * so a future `denied`/`failed` opt-in never mis-fires an availability email (issue #50).
 */
export function hasNotifyOn(raw: unknown): boolean {
  return sanitizeNotifyOn(raw).length > 0;
}

// --- Contact email: the single deliverability shape + predicate ---------------
// One schema for "a deliverable contact address": trim + lowercase, then a valid email
// bounded at 254. Reused as the local-login identity (`localCredentialsSchema.email`), the
// OIDC email-claim gate (`makeOidcMapper`), and the availability-send predicate — so the
// "has usable email" decision can never drift between the UI (`emailNotifyAvailable`) and the
// poller sweep (issue #120). Non-`.strict()` domain schema; the error string only surfaces for
// the local-login form (OIDC/sweep use the normalizing helper below and ignore it).
export const contactEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email('enter a valid email address').max(254));

/**
 * Normalize an arbitrary stored/claimed email into a deliverable address, or `null`. Trims +
 * lowercases and enforces the `contactEmailSchema` bound; an empty, whitespace-only, malformed,
 * or over-length value (or `null`/`undefined`) collapses to `null` rather than throwing. This is
 * the SINGLE SOURCE OF TRUTH for both the value we deliver to and the predicate that gates the
 * send — the OIDC mapper stores its result, the sweep sends its result, and the UI/sweep gate on
 * {@link hasDeliverableContact}, so the "available" signal and the address delivered can't diverge.
 */
export function normalizeContactEmail(email: string | null | undefined): string | null {
  if (email == null) return null;
  const parsed = contactEmailSchema.safeParse(email);
  return parsed.success ? parsed.data : null;
}

/** Whether a stored/claimed email parses as a deliverable contact. Derived from {@link normalizeContactEmail}. */
export function hasDeliverableContact(email: string | null | undefined): boolean {
  return normalizeContactEmail(email) !== null;
}

// --- Send-to-Kindle device address (issue #142) -------------------------------
// The user's own Kindle device address, the destination Send-to-Kindle delivers an ebook to. A
// STRICTER SUBTYPE of `contactEmailSchema`, not a parallel construction: it DERIVES from it, so the
// common mailbox contract (trim + lowercase + structural validity + the 254 bound) has exactly one
// home and can't drift between the contact and Kindle paths. The only addition is the domain.
//
// Amazon issues these on `@kindle.com` only. The check is an EXACT-LABEL comparison against the
// substring after the FINAL `@` — never `.endsWith('kindle.com')` (which accepts `a@evilkindle.com`)
// and never `.includes(...)` (which additionally accepts `a@kindle.com.evil.io`). It is attached with
// `.refine()`, i.e. AFTER the trim/lowercase pipe, so `USER@KINDLE.COM` normalizes first and passes —
// a constraint on the raw input would reject it.
//
// Amazon also issues `@free.kindle.com` (Wi-Fi-only free delivery); those are deliberately rejected
// here. Widening the accepted domain set is a product decision, not an implementation detail.
export const KINDLE_EMAIL_DOMAIN = 'kindle.com';

/** The domain label of an already-normalized address: everything after the FINAL `@`. */
function emailDomain(normalized: string): string {
  return normalized.slice(normalized.lastIndexOf('@') + 1);
}

export const kindleEmailSchema = contactEmailSchema.refine(
  (value) => emailDomain(value) === KINDLE_EMAIL_DOMAIN,
  { message: `enter your Kindle address (ends in @${KINDLE_EMAIL_DOMAIN})` },
);

// Shape returned to the client for a user.
export const userDtoSchema = z.object({
  publicId: z.string(),
  username: z.string(),
  // Which auth method this identity came from (e.g. 'local', 'plex', 'authelia',
  // or a configured OIDC provider id). Display-only on the client.
  authProvider: z.string(),
  email: z.string().nullable(),
  thumb: z.string().nullable(),
  role: roleSchema,
  status: userStatusSchema,
  requestQuota: requestQuotaSchema, // the four-mode per-user override ({ mode:'inherit' } = app default)
  autoApprove: z.boolean(),
  createdAt: z.string(),
});
export type UserDto = z.infer<typeof userDtoSchema>;

// Admin user management: partial update of a user. All fields optional; strict so
// stray keys are rejected. `requestQuota` omitted = no change; `{ mode:'inherit' }` = fall back to
// the app default. `status` drives the approval queue (approve = active, reject = rejected).
export const updateUserBodySchema = z
  .object({
    role: roleSchema.optional(),
    status: userStatusSchema.optional(),
    requestQuota: requestQuotaSchema.optional(),
    autoApprove: z.boolean().optional(),
  })
  .strict();
export type UpdateUserBody = z.infer<typeof updateUserBodySchema>;

// `GET /api/me` — the current user plus their RESOLVED effective rolling-window quota. `mode` is
// authoritative (not `limit === null`): `unlimited` → limit/remaining null; `limited` → positive
// limit + clamped remaining; `blocked` → limit null, remaining 0 (the badge renders "blocked").
export const meDtoSchema = userDtoSchema.extend({
  quota: z.object({
    mode: z.enum(['unlimited', 'limited', 'blocked']),
    limit: z.number().int().positive().nullable(), // null for unlimited & blocked
    used: z.number().int(),
    remaining: z.number().int().nullable(), // null for unlimited
    windowDays: quotaWindowDaysSchema,
  }),
  // The caller's own requester-notification opt-in set (issue #50). Self-scoped — NOT on the
  // admin `userDtoSchema`, so no admin surface exposes another user's preferences.
  notifyOn: z.array(notifiableTransitionSchema),
  // True IFF the caller has a non-null email AND the operator has a usable email-notifier SMTP
  // source. Drives the opt-in control's enabled state and the one-time discoverability nudge;
  // opt-in STORAGE is permissive (may outlive a contact), but DELIVERY + the UI gate on this.
  emailNotifyAvailable: z.boolean(),
  // The caller's own Send-to-Kindle device address, or null when never set (issue #142). SELF-SCOPED
  // ONLY — deliberately on `MeDto` and NOT on the admin `userDtoSchema`: it's the caller's own PII and
  // no admin surface ever exposes (or edits) another user's Kindle address. Populated in `buildMeDto`,
  // never in `UserService.toDto` (the admin mapper).
  kindleEmail: z.string().nullable(),
});
export type MeDto = z.infer<typeof meDtoSchema>;

// `PATCH /api/me` — the self-scoped account write. Carries the caller's own requester-notification
// opt-in set AND/OR their contact email; both fields are INDEPENDENT and OPTIONAL, so a body may
// set email only, notifyOn only, both, or neither.
//   • `notifyOn` — each element must be in `NOTIFIABLE_TRANSITIONS` or Zod rejects it (400). Omitted
//     leaves the stored set untouched. Stored as-is regardless of email/SMTP state
//     (storage-permissive; no 403 on enable-without-contact).
//   • `email` — the stored CONTACT address (never the login `authSubject`). Omitted = no change;
//     `null` clears it (re-enabling OIDC backfill next login); a non-empty value is trimmed +
//     lowercased + validated by the shared `contactEmailSchema` (#120), so an invalid /
//     whitespace-only / over-254 value is a 400. Because `contactEmailSchema` rejects the empty
//     string, `email: ""` is a 400 (NOT a clear) — clearing is `email: null` only.
//   • `kindleEmail` — the caller's own Send-to-Kindle device address (#142). Same set/clear/omit
//     semantics as `email` (omitted = no change, `null` clears, `""` is a 400), validated by
//     `kindleEmailSchema` so only an exact `@kindle.com` mailbox is storable.
// The three fields are MUTUALLY INDEPENDENT: any subset applies without touching the others.
// Strict so a stray key (e.g. an attempt to smuggle `role`) is refused — this endpoint can never
// mutate anything but the caller's own opt-in set, contact email, and Kindle address.
export const updateMeBodySchema = z
  .object({
    notifyOn: z.array(notifiableTransitionSchema).optional(),
    email: contactEmailSchema.nullable().optional(),
    kindleEmail: kindleEmailSchema.nullable().optional(),
  })
  .strict();
export type UpdateMeBody = z.infer<typeof updateMeBodySchema>;

// --- Auth: login screen + local auth ----------------------------------------

// Server-driven login screen. The client renders the password form when `local`
// is true, plus one button per configured OIDC provider. Server is source of truth.
export const authProvidersDtoSchema = z.object({
  local: z.boolean(),
  providers: z.array(z.object({ id: z.string(), label: z.string() })),
});
export type AuthProvidersDto = z.infer<typeof authProvidersDtoSchema>;

// Local-auth credentials. Email is the login identity (lowercased → the stable subject
// key) and doubles as the user's contact + display source. Password floor is 8 (length is
// the cheap, effective lever).
export const localCredentialsSchema = z
  .object({
    email: contactEmailSchema,
    password: z.string().min(8, 'password must be at least 8 characters').max(200),
  })
  .strict();
export type LocalCredentials = z.infer<typeof localCredentialsSchema>;
