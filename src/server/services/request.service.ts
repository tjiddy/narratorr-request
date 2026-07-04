import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../../db/client.js';
import { requests, users, type RequestRow } from '../../db/schema.js';
import type { Notifier } from './notifications/index.js';
import { redact } from './notifications/redact.js';
import type { NotifierLogger } from './notifications/types.js';
import type { RequesterEmailSender } from './notifications/requester-email.js';
import { sanitizeNotifyOn } from '../../shared/schemas/user.js';
import type { UserService } from './user.service.js';
import type {
  CreateRequestBody,
  DecisionBody,
  RequestDto,
  RequestStatus,
} from '../../shared/schemas/request.js';
import { OPEN_REQUEST_STATUSES, ACTIVE_REQUEST_STATUSES, APPROVED_REQUEST_STATUSES } from '../../shared/schemas/request.js';
import { roleSchema, type Role, type RequestQuotaMode } from '../../shared/schemas/user.js';
import type { DefaultQuota, QuotaWindowDays } from '../../shared/schemas/connectors.js';
import { ADD_BOOK_ERROR_CODES, type V1Book } from '../../shared/schemas/v1/books.js';
import type { INarratorrClient } from './narratorr-client.js';
import { NarratorrError } from './narratorr-client.js';
import { publicId } from '../util/ids.js';
import { conflict, notFound, quotaBlocked, tooManyRequests } from '../util/errors.js';
import { isUniqueViolation } from '../util/db.js';

/**
 * A user's RESOLVED effective quota — what actually gates a request after role + per-user override
 * + app default are folded together. A number only ever means a positive cap (`limited`); the other
 * two modes are first-class, so "no cap" (`unlimited`) and "hard admin block" (`blocked`) are never
 * confused with each other or with a numeric limit.
 */
export type EffectiveQuota =
  | { mode: 'unlimited' }
  | { mode: 'limited'; limit: number }
  | { mode: 'blocked' };

/** The app default's effective mode (the `inherit` fall-through target) — `blocked` can't be a
 *  default, only a per-user state, so it's excluded here. */
export type DefaultEffectiveQuota = { mode: 'unlimited' } | { mode: 'limited'; limit: number };

/**
 * Quota / approval policy. Built from app_settings + config at boot and handed
 * in (keeps the service free of the config singleton, so it's unit-testable).
 */
export interface RequestPolicy {
  /** App-wide default quota mode; per-user `requestQuota` modes override it. */
  defaultQuota: DefaultEffectiveQuota;
  windowDays: QuotaWindowDays;
  autoApproveRoles: Role[];
}

/** Narrow a `DefaultQuota` (the settings/DTO shape, carrying `windowDays`) to the policy's
 *  effective-mode shape (windowDays lives on the policy separately). */
function toDefaultEffective(quota: DefaultQuota): DefaultEffectiveQuota {
  return quota.mode === 'limited' ? { mode: 'limited', limit: quota.limit } : { mode: 'unlimited' };
}

/**
 * Build the boot request policy from the SANITIZED default quota — the single seam boot uses to
 * seed `RequestService` (see `src/server/index.ts`). Extracted (and structurally typed over just
 * `getDefaultQuota()`, not the whole settings service) so the "seed from the sanitizer, not the
 * raw `app_settings` columns" guarantee is directly testable: a regression that read the raw row
 * instead of `getDefaultQuota()` fails the policy assertion rather than slipping through an
 * in-test reconstruction of the wiring. `autoApproveRoles` stays sourced from the settings row
 * (it isn't part of the quota narrowing).
 */
export async function resolveRequestPolicy(
  source: { getDefaultQuota(): Promise<DefaultQuota> },
  autoApproveRoles: Role[],
): Promise<RequestPolicy> {
  const quota = await source.getDefaultQuota();
  return { defaultQuota: toDefaultEffective(quota), windowDays: quota.windowDays, autoApproveRoles };
}

/**
 * Narrow stored `auto_approve_roles` JSON into a `Role[]` so a legacy / hand-edited / non-array value
 * can't ride an unvalidated `as Role[]` cast into the boot policy. Mirrors the connector/quota
 * degrade-and-warn discipline: any failure (non-array, or an unknown role) warns exactly ONCE and
 * falls back to `['admin']`; a valid array passes through. Exported so it's spy-logger testable.
 */
export function sanitizeAutoApproveRoles(raw: unknown, logger: { warn(obj: unknown, msg?: string): void }): Role[] {
  const parsed = z.array(roleSchema).safeParse(raw);
  if (!parsed.success) logger.warn({ raw }, 'auto_approve_roles failed the role schema — falling back to ["admin"]');
  return parsed.success ? parsed.data : ['admin'];
}

/** Effective rolling-window usage for the `/api/me` quota badge. `mode` is authoritative:
 *  `unlimited` → limit/remaining null; `limited` → positive limit + clamped remaining; `blocked`
 *  → limit null, remaining 0. `used` is always the real in-window count. */
export interface QuotaUsage {
  mode: EffectiveQuota['mode'];
  limit: number | null;
  used: number;
  remaining: number | null;
  windowDays: QuotaWindowDays;
}

/**
 * Wiring for the notification side effects the request lifecycle fires — the admin-facing
 * `request.failed` heads-up (issue #60) AND the requester-facing `available` email (issue #50).
 * Optional as a whole — when absent the service simply doesn't emit (existing call-sites that
 * don't care about notifications keep their 3-arg construction). Each side effect is
 * fire-and-forget and NEVER throws into the request/poll path.
 */
export interface RequestFailureNotifyDeps {
  /**
   * Reads the CURRENT notifier at call time. MUST be an accessor, not a captured
   * instance: the live notifier is rebuilt and reassigned on every notifier-settings
   * change, so capturing it would dispatch failed-notifications through a stale channel set.
   */
  getNotifier: () => Notifier;
  /** Resolves `requester.username` (failed) / the requester's opt-in + email (available); an absent row is a no-op. */
  users: Pick<UserService, 'getById'>;
  /**
   * Requester-email sender (issue #50). Optional — when absent, `available` transitions emit no
   * requester email (the failed path is unaffected). Builds its SMTP transport from the operator's
   * first usable email notifier at send time; a missing source is its own silent no-op.
   */
  requesterEmail?: RequesterEmailSender;
  /**
   * Optional log sink for fire-and-forget emission faults (a requester lookup that rejects, or a
   * notifier dispatch that rejects). Without it a lost `request.failed` is undiagnosable; the
   * emission stays non-blocking either way — these are breadcrumbs, never thrown to the caller.
   */
  logger?: NotifierLogger;
}

/** Username used when the requester row is gone (e.g. deleted account) — the admin still hears it failed. */
const UNKNOWN_REQUESTER = '(unknown requester)';

export class RequestService {
  constructor(
    private readonly db: Db,
    private readonly client: INarratorrClient,
    private readonly policy: RequestPolicy,
    private readonly notifyDeps?: RequestFailureNotifyDeps,
  ) {}

  // --- reads -----------------------------------------------------------------

  async getByPublicId(pid: string): Promise<RequestRow | undefined> {
    return this.db.query.requests.findFirst({ where: eq(requests.publicId, pid) });
  }

  async list(opts: {
    userId?: number;
    status?: RequestStatus;
    limit: number;
    offset: number;
  }): Promise<{ data: RequestDto[]; total: number }> {
    // "approved" filters the whole post-approval lifecycle (APPROVED_REQUEST_STATUSES),
    // not the transient `approved` row; every other status filters exactly.
    const conds = [
      opts.userId !== undefined ? eq(requests.userId, opts.userId) : undefined,
      opts.status === undefined
        ? undefined
        : opts.status === 'approved'
          ? inArray(requests.status, [...APPROVED_REQUEST_STATUSES])
          : eq(requests.status, opts.status),
    ].filter(Boolean);
    const where = conds.length ? and(...conds) : undefined;

    const rows = await this.db
      .select({ request: requests, requester: { publicId: users.publicId, username: users.username } })
      .from(requests)
      .innerJoin(users, eq(requests.userId, users.id))
      .where(where)
      // `requested_at` is second-resolution (unixepoch()), so rows created in the same
      // second tie. Add the monotonic PK as a unique secondary key to make the total order
      // deterministic — otherwise adjacent offset pages over tied rows could skip/duplicate.
      .orderBy(desc(requests.requestedAt), desc(requests.id))
      .limit(opts.limit)
      .offset(opts.offset);

    const [{ n: total } = { n: 0 }] = await this.db
      .select({ n: sql<number>`count(*)` })
      .from(requests)
      .where(where);

    return { data: rows.map((r) => this.toDto(r.request, r.requester)), total };
  }

  toDto(row: RequestRow, requester: { publicId: string; username: string }): RequestDto {
    return {
      publicId: row.publicId,
      asin: row.asin,
      title: row.title,
      author: row.author,
      narrator: row.narrator,
      coverUrl: row.coverUrl,
      status: row.status,
      note: row.note,
      failureReason: row.failureReason,
      requestedAt: row.requestedAt.toISOString(),
      decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
      narratorrBookId: row.narratorrBookId,
      requester,
    };
  }

  // --- quota -----------------------------------------------------------------

  isAutoApprove(role: Role): boolean {
    return this.policy.autoApproveRoles.includes(role);
  }

  /**
   * Update the app-wide default quota (limit + rolling window) after a Settings save — mirrors
   * the notifier dispatcher's reconfigure-on-save so the new default takes effect without a
   * restart. Per-user overrides and admin-unlimited are unaffected; only the fall-through
   * default and the rolling-window cutoff change.
   */
  reconfigureQuota(quota: DefaultQuota): void {
    this.policy.defaultQuota = toDefaultEffective(quota);
    this.policy.windowDays = quota.windowDays;
  }

  /**
   * Resolve a user's effective quota policy. Auto-approve roles (admins) are always `unlimited`;
   * everyone else resolves their per-user mode: `inherit` falls through to the app default;
   * `unlimited`/`limited`/`blocked` are taken as-is. A `limited` mode trusts its positive limit
   * (the DB mode↔limit CHECK guarantees one); an impossible incoherent row degrades to the app
   * default rather than honoring a null/zero cap.
   */
  resolveQuota(user: { role: Role; requestQuotaMode: RequestQuotaMode; requestQuotaLimit: number | null }): EffectiveQuota {
    if (user.role === 'admin') return { mode: 'unlimited' };
    switch (user.requestQuotaMode) {
      case 'unlimited':
        return { mode: 'unlimited' };
      case 'blocked':
        return { mode: 'blocked' };
      case 'limited':
        return user.requestQuotaLimit && user.requestQuotaLimit > 0
          ? { mode: 'limited', limit: user.requestQuotaLimit }
          : this.policy.defaultQuota;
      case 'inherit':
        return this.policy.defaultQuota;
    }
  }

  /**
   * Rolling-window usage (PLAN decision #5): count requests created in the last
   * `windowDays` whose status still occupies a slot — `pending`/`approved`/
   * `acquiring`/`available`. `failed` and `denied` are never counted. Shapes the count into the
   * effective-mode badge contract: `limited` clamps remaining at 0; `blocked` reports
   * remaining 0 (limit null); `unlimited` reports both null.
   */
  async quotaUsage(userId: number, effective: EffectiveQuota): Promise<QuotaUsage> {
    const used = await this.countInWindow(userId);
    const windowDays = this.policy.windowDays;
    if (effective.mode === 'limited') return { mode: 'limited', limit: effective.limit, used, remaining: Math.max(0, effective.limit - used), windowDays };
    if (effective.mode === 'blocked') return { mode: 'blocked', limit: null, used, remaining: 0, windowDays };
    return { mode: 'unlimited', limit: null, used, remaining: null, windowDays };
  }

  /** Count a user's slot-occupying requests inside the configured rolling window. */
  private async countInWindow(userId: number): Promise<number> {
    const cutoff = new Date(Date.now() - this.policy.windowDays * 86_400_000);
    const [{ n: used } = { n: 0 }] = await this.db
      .select({ n: sql<number>`count(*)` })
      .from(requests)
      .where(
        and(
          eq(requests.userId, userId),
          gte(requests.requestedAt, cutoff),
          inArray(requests.status, [...OPEN_REQUEST_STATUSES]),
        ),
      );
    return used;
  }

  // --- create ----------------------------------------------------------------

  /**
   * Create a request for the given user. Enforces the rolling quota (skipped for
   * auto-approve roles), de-dupes an existing active request for the same
   * (user, asin), and — when the role auto-approves — marks it approved and hands
   * it off to Narratorr immediately. Returns the row + whether it was newly created.
   */
  async create(userId: number, body: CreateRequestBody): Promise<{ row: RequestRow; created: boolean }> {
    const user = await this.db.query.users.findFirst({ where: eq(users.id, userId) });
    if (!user) throw notFound('user not found');

    // De-dupe: an existing ACTIVE request for this (user, asin) is returned as-is.
    const existing = await this.findActiveDuplicate(userId, body.asin);
    if (existing) return { row: existing, created: false };

    await this.enforceQuota(user, userId);

    // Auto-approve when the role auto-approves (admin) OR the user is individually flagged.
    const autoApprove = this.isAutoApprove(user.role) || user.autoApprove;

    const inserted = await this.insertRequest(userId, body, autoApprove);
    if (!inserted.created) return inserted; // lost the unique-index race → existing row
    const row = autoApprove ? await this.handoff(inserted.row) : inserted.row;
    return { row, created: true };
  }

  /** An existing ACTIVE (pending/approved/acquiring/available) request for this (user, asin). */
  private findActiveDuplicate(userId: number, asin: string): Promise<RequestRow | undefined> {
    return this.db.query.requests.findFirst({
      where: and(
        eq(requests.userId, userId),
        eq(requests.asin, asin),
        inArray(requests.status, [...ACTIVE_REQUEST_STATUSES]),
      ),
    });
  }

  /**
   * Enforce the user's effective quota on request-create. `unlimited` → allow; `blocked` → reject
   * with `403 QUOTA_BLOCKED` (a hard admin denial, regardless of usage); `limited` → reject with
   * `429 QUOTA_EXCEEDED` once no slot remains. Applies to everyone non-admin — auto-approved users
   * included; auto-approve only decides pending-vs-approved, not the cap.
   */
  private async enforceQuota(
    user: { role: Role; requestQuotaMode: RequestQuotaMode; requestQuotaLimit: number | null },
    userId: number,
  ): Promise<void> {
    const effective = this.resolveQuota(user);
    if (effective.mode === 'unlimited') return;
    if (effective.mode === 'blocked') throw quotaBlocked();
    const usage = await this.quotaUsage(userId, effective);
    if (usage.remaining !== null && usage.remaining <= 0) {
      throw tooManyRequests(
        'QUOTA_EXCEEDED',
        `Request quota reached (${usage.used}/${usage.limit} in the last ${usage.windowDays} days).`,
      );
    }
  }

  /**
   * Insert the new request row. `created: false` means the partial unique index fired
   * between the preflight de-dupe and this insert (a concurrent identical request), in
   * which case the existing active row is returned instead.
   */
  private async insertRequest(
    userId: number,
    body: CreateRequestBody,
    autoApprove: boolean,
  ): Promise<{ row: RequestRow; created: boolean }> {
    const now = new Date();
    try {
      const [created] = await this.db
        .insert(requests)
        .values({
          publicId: publicId('rq'),
          userId,
          asin: body.asin,
          title: body.title,
          author: body.author ?? null,
          narrator: body.narrator ?? null,
          coverUrl: body.coverUrl ?? null,
          note: body.note ?? null,
          status: autoApprove ? 'approved' : 'pending',
          ...(autoApprove ? { decidedBy: userId, decidedAt: now } : {}),
        })
        .returning();
      if (!created) throw new Error('insert returned no row');
      return { row: created, created: true };
    } catch (err) {
      // Race: the partial unique index fired between our preflight and insert.
      if (isUniqueViolation(err)) {
        const dupe = await this.findActiveDuplicate(userId, body.asin);
        if (dupe) return { row: dupe, created: false };
      }
      throw err;
    }
  }

  // --- admin decision --------------------------------------------------------

  async decide(adminId: number, pid: string, decision: DecisionBody): Promise<RequestRow> {
    const existing = await this.getByPublicId(pid);
    if (!existing) throw notFound('request not found');

    const now = new Date();
    const nextStatus = decision.action === 'deny' ? 'denied' : 'approved';
    // Atomic claim: transition ONLY while still pending. Two concurrent admins (or a
    // double-submit) can't both win — the loser's UPDATE matches zero rows. This
    // closes the check-then-update race and prevents approving a denied request.
    const [claimed] = await this.db
      .update(requests)
      .set({ status: nextStatus, decidedBy: adminId, decidedAt: now, note: decision.note ?? existing.note })
      .where(and(eq(requests.id, existing.id), eq(requests.status, 'pending')))
      .returning();
    if (!claimed) {
      const fresh = await this.getByPublicId(pid);
      throw conflict('NOT_PENDING', `request is ${fresh?.status ?? 'gone'}, not pending`);
    }
    return decision.action === 'approve' ? this.handoff(claimed) : claimed;
  }

  // --- Narratorr handoff -----------------------------------------------------

  /**
   * Hand an approved request to Narratorr's `POST /books` command. The client makes
   * the add idempotent by ASIN (a 409 "already exists" is resolved to the existing
   * book), so it's safe to retry and never double-adds — no idempotency key. An
   * already-imported book short-circuits straight to `available`. On failure we
   * re-throw either way, but only TERMINAL failures (unresolvable ASIN) mark the
   * request `failed`; TRANSIENT ones (429/5xx/network) leave it `approved` so the
   * poller's stranded-handoff retry self-heals instead of burning the request.
   */
  async handoff(row: RequestRow): Promise<RequestRow> {
    if (row.status !== 'approved') return row;
    try {
      const book = await this.client.addBook(row.asin);
      const next = this.mapBookStatus(book.status);
      // The book itself came back terminal-failed: claim the failed edge atomically
      // (emits request.failed once) while preserving the resolved book linkage.
      if (next === 'failed') {
        const failed = await this.transitionToFailed(row, bookStatusFailureReason(book.status), {
          narratorrBookId: book.id,
        });
        return failed ?? row;
      }
      // Atomically claim the OBSERVED `approved` edge (mirrors transitionToFailed): the real race
      // is handler-vs-poller — create()'s in-flight handoff vs recoverHandoff firing a second
      // handoff on the same `(approved, bookId NULL)` row. Both call addBook (idempotent by ASIN),
      // then both reach here; the `WHERE status = row.status` guard lets exactly ONE land the edge,
      // so the availability email fires exactly once (only when the claim returns a row). The loser
      // matches zero rows and emits nothing.
      const [updated] = await this.db
        .update(requests)
        .set({ narratorrBookId: book.id, status: next })
        .where(and(eq(requests.id, row.id), eq(requests.status, row.status)))
        .returning();
      // A book that was already imported short-circuits approved → available here (never entering
      // acquiring), so this is the ONLY available emit site for the synchronous / recovered paths.
      if (updated && next === 'available') this.emitAvailable(updated);
      return updated ?? row;
    } catch (err) {
      if (!isTerminalHandoffError(err)) throw err; // transient — stays `approved`, poller retries
      // Terminal handoff failure: claim the failed edge (emits request.failed once) and
      // PRESERVE the existing rethrow — callers/tests depend on the error surfacing.
      await this.transitionToFailed(row, handoffFailureReason(err));
      throw err;
    }
  }

  /**
   * Poller-facing stranded-`approved` handoff recovery. Differs from the user-facing {@link handoff}
   * in how it treats a TERMINAL failure: there it is a SUCCESSFUL reconciliation — the request
   * reaches its correct `failed` state and emits `request.failed` once — so it RESOLVES instead of
   * re-throwing, letting the poller count it as a transition rather than an upstream error (which
   * would wrongly trip backoff even though the terminal transition actually succeeded). TRANSIENT
   * failures still throw, so the poller counts an upstream error and retries on the next pass.
   * Returns `'recovered'` when the request advanced (→ acquiring/available) and `'failed'` when it
   * landed terminal (the added book came back failed, or a terminal handoff error).
   */
  async recoverHandoff(row: RequestRow): Promise<'recovered' | 'failed'> {
    try {
      const result = await this.handoff(row);
      return result.status === 'failed' ? 'failed' : 'recovered';
    } catch (err) {
      if (!isTerminalHandoffError(err)) throw err; // transient — poller counts an upstream error & retries
      return 'failed'; // terminal: handoff already claimed `failed` and emitted once — a real transition
    }
  }

  /**
   * Atomically claim the `row.status` → `failed` edge and emit `request.failed` EXACTLY
   * once. The `WHERE status = row.status` guard asserts the OBSERVED source state — not merely
   * "not failed" — so two racing callers can't both win (the loser's row has already moved off
   * the observed state, its UPDATE returns no row, it emits nothing) AND a stale caller can't
   * clobber a NEWER terminal state: a row that moved on to `available`/`denied` behind the
   * caller's back no longer matches, so the claim lands zero rows and the newer state stands.
   * All callers pass a row in a live non-`failed` state (handoff: `approved`; applyBook/poller:
   * `acquiring`), so the failed edge is reachable. Returns the updated row when THIS caller
   * performed the transition, else null (moved on, already failed, or row gone). `extra` carries
   * path-specific fields to preserve (e.g. `narratorrBookId` on the handoff path, which a
   * status-only write would drop).
   */
  private async transitionToFailed(
    row: RequestRow,
    reason: string,
    extra: { narratorrBookId?: string | null } = {},
  ): Promise<RequestRow | null> {
    const [updated] = await this.db
      .update(requests)
      .set({ status: 'failed', failureReason: reason, ...extra })
      .where(and(eq(requests.id, row.id), eq(requests.status, row.status)))
      .returning();
    if (!updated) return null;
    this.emitFailed(updated, reason);
    return updated;
  }

  /**
   * Fire-and-forget `request.failed` emission. NEVER throws into the request/poll path:
   * the failed transition is already committed, so a missing requester or a dispatch
   * hiccup must not unwind it. Resolves the requester via the live UserService and
   * dispatches through the LIVE notifier (read at call time). A missing requester row
   * still emits with a stable placeholder username — the admin needs to hear it failed.
   */
  private emitFailed(row: RequestRow, reason: string | null): void {
    const deps = this.notifyDeps;
    if (!deps) return;
    void (async () => {
      // A requester lookup fault (DB fault) must NOT lose the notification — the admin still
      // needs to hear it failed. Log a redacted breadcrumb and fall back to the placeholder.
      let requester: { username: string } | undefined;
      try {
        requester = await deps.users.getById(row.userId);
      } catch (err) {
        // redact() before logging: a lookup fault's error text could embed a secret-bearing
        // value, and the breadcrumb must never carry one raw (URL-pattern scrub; no per-channel
        // secrets to exact-match here — those live inside the dispatcher).
        deps.logger?.warn(
          { err: redact(err), request: row.publicId },
          'request.failed: requester lookup failed; emitting with placeholder username',
        );
      }
      try {
        await deps.getNotifier().notify({
          event: 'request.failed',
          request: {
            publicId: row.publicId,
            title: row.title,
            author: row.author,
            asin: row.asin,
            coverUrl: row.coverUrl,
          },
          requester: { username: requester?.username ?? UNKNOWN_REQUESTER },
          reason,
        });
      } catch (err) {
        // A lost notification must be diagnosable — without this breadcrumb a dropped
        // request.failed is invisible. The failed transition already committed; never propagate.
        // redact() before logging: a dispatch error can embed a capability webhook URL or a
        // token-in-path (the very reason the dispatcher redacts), so scrub it here too.
        deps.logger?.warn(
          { err: redact(err), request: row.publicId },
          'request.failed: notifier dispatch failed; notification lost',
        );
      }
    })().catch((err) => {
      // Final backstop: both awaits above are individually guarded, so this only fires on a
      // truly unexpected throw. The failed transition already landed; swallow into a (redacted)
      // breadcrumb.
      deps.logger?.warn({ err: redact(err), request: row.publicId }, 'request.failed: emission failed unexpectedly');
    });
  }

  /**
   * Fire-and-forget requester `available` email (issue #50). Called only when an available
   * atomic claim landed a row, so it fires EXACTLY ONCE per transition. NEVER throws into the
   * request/poll path — the available transition is already committed, so an opted-out user, a
   * missing contact, a missing SMTP source, or a send fault must not unwind it. Resolves the
   * requester at send time (opt-in and contact both live on their row and can have changed): a
   * missing row / not-opted-in / null email are all valid SILENT no-ops, not invariant violations.
   */
  private emitAvailable(row: RequestRow): void {
    const deps = this.notifyDeps;
    const sender = deps?.requesterEmail;
    if (!deps || !sender) return;
    void (async () => {
      let user: Awaited<ReturnType<typeof deps.users.getById>>;
      try {
        user = await deps.users.getById(row.userId);
      } catch (err) {
        // redact() before logging: a lookup fault's error text could embed a secret-bearing value.
        deps.logger?.warn(
          { err: redact(err), request: row.publicId },
          'request.available: requester lookup failed; skipping email',
        );
        return;
      }
      if (!user) return; // requester row gone (deleted account) — nothing to email
      if (!sanitizeNotifyOn(user.notifyOn).includes('available')) return; // not opted in
      if (!user.email) return; // opted in but no contact — a valid silent no-op (Design #4)
      try {
        await sender.send({
          to: user.email,
          transition: 'available',
          request: { title: row.title, author: row.author },
        });
      } catch (err) {
        // A lost requester email must be diagnosable; the available transition already committed,
        // never propagate. redact() before logging: a send fault can embed SMTP credentials.
        deps.logger?.warn(
          { err: redact(err), request: row.publicId },
          'request.available: requester email dispatch failed; notification lost',
        );
      }
    })().catch((err) => {
      deps.logger?.warn({ err: redact(err), request: row.publicId }, 'request.available: emission failed unexpectedly');
    });
  }

  // --- reconciliation (poller) ----------------------------------------------

  /**
   * Requests currently mid-flight that the poller should refresh. Ordered oldest-first
   * and capped in SQL so a tick never does an unbounded read and the oldest in-flight
   * requests are always serviced (no starvation from an in-memory slice of an
   * unordered set). Strict per-row fair rotation (a `nextPollAt` cursor) is a follow-up.
   */
  async findAcquiring(limit = 100): Promise<RequestRow[]> {
    return this.db.query.requests.findMany({
      where: and(eq(requests.status, 'acquiring'), sql`${requests.narratorrBookId} IS NOT NULL`),
      orderBy: requests.requestedAt,
      limit,
    });
  }

  /**
   * Approved requests with no book yet — i.e. the process died between approval and
   * handoff. The poller re-runs the (idempotent) handoff to self-heal, so an
   * approved request is never permanently stranded.
   */
  async findApprovedAwaitingHandoff(limit = 100): Promise<RequestRow[]> {
    return this.db.query.requests.findMany({
      where: and(eq(requests.status, 'approved'), sql`${requests.narratorrBookId} IS NULL`),
      orderBy: requests.requestedAt,
      limit,
    });
  }

  /**
   * Apply a freshly-polled book to a request. Returns the new status if it changed,
   * else null (so the poller logs only on transitions — there is no requester
   * notification today; see #50). We mirror narratorr's
   * lifecycle and never invent a terminal state on a timer: a request stays `acquiring`
   * for as long as the book is pre-`imported` (a not-found book legitimately sits
   * `wanted` until narratorr's next scheduled search) and only goes terminal when
   * narratorr itself reports `imported` / `failed` / `missing`. Timing is narratorr's.
   */
  async applyBook(row: RequestRow, book: V1Book): Promise<RequestStatus | null> {
    const next = this.mapBookStatus(book.status);
    const bookId = book.id ?? row.narratorrBookId;
    if (next === 'acquiring' && bookId === row.narratorrBookId) return null; // no change worth persisting
    // A polled book that went terminal-failed claims the failed edge atomically (emits
    // request.failed once), preserving the book linkage. null = another caller already
    // failed it → no transition to report.
    if (next === 'failed') {
      const failed = await this.transitionToFailed(row, bookStatusFailureReason(book.status), {
        narratorrBookId: bookId,
      });
      return failed ? 'failed' : null;
    }
    // Claim the OBSERVED (`acquiring`) edge atomically — the same `WHERE status = <observed>
    // … .returning()` guard as the failed edge. This is the normal `acquiring → available` write;
    // emitting the availability email only when the claim lands a row keeps it exactly-once even
    // if this path ever raced another writer (the loser matches zero rows and emits nothing).
    const [updated] = await this.db
      .update(requests)
      .set({ status: next, narratorrBookId: bookId })
      .where(and(eq(requests.id, row.id), eq(requests.status, row.status)))
      .returning();
    if (!updated) return null; // lost the claim — the row already moved off the observed status
    if (next === 'available') this.emitAvailable(updated);
    return next === row.status ? null : next;
  }

  /**
   * Mark a request failed when its book can no longer be found (404 on poll). Thin wrapper
   * over the atomic failed-transition helper. Returns whether THIS call performed the
   * transition, so the poller counts/logs the edge exactly once (and doesn't re-emit on a
   * book that was already failed).
   */
  async markFailed(row: RequestRow, reason: string): Promise<boolean> {
    return (await this.transitionToFailed(row, reason)) !== null;
  }

  private mapBookStatus(status: V1Book['status']): RequestStatus {
    switch (status) {
      case 'imported':
        return 'available';
      case 'failed':
      case 'missing':
        return 'failed';
      default:
        return 'acquiring'; // wanted | searching | downloading | importing
    }
  }
}

/**
 * Whether a handoff error is terminal (retrying can't fix it → fail the request) vs.
 * transient (429 rate-limit / 5xx / network → leave `approved` for the poller to
 * retry). A non-Narratorr error (e.g. a DB fault) is terminal so it can't loop forever.
 */
function isTerminalHandoffError(err: unknown): boolean {
  if (!(err instanceof NarratorrError)) return true;
  // 400 malformed, 409 with no usable existingId, 422 unresolvable ASIN.
  return err.upstreamStatus === 400 || err.upstreamStatus === 409 || err.upstreamStatus === 422;
}

// --- Friendly failure reasons ------------------------------------------------
// Once a `failureReason` is surfaced to users/admins it must read as plain English,
// not a raw upstream code. These map every terminal failure cause to a friendly string.
// Branch on the upstream CODE (narratorr #1545), never the human message text.

/** Per-code friendly text for the add-handoff terminal errors. */
const HANDOFF_FAILURE_REASONS: Record<string, string> = {
  [ADD_BOOK_ERROR_CODES.editionRejected]: "This edition is excluded by the library's filters.",
  [ADD_BOOK_ERROR_CODES.asinNotResolved]: "Couldn't find this book in the catalog.",
  [ADD_BOOK_ERROR_CODES.invalidRecord]: 'Incomplete book data from the provider.',
};

/** "The book is gone upstream" reason — written by the poller's 404 path (status-poller). */
export const BOOK_VANISHED_REASON = 'This book is no longer available upstream.';

/**
 * Friendly reason for a TERMINAL handoff error. A recognized `NarratorrError` code maps
 * to its per-code message; an unknown terminal code falls back to the readable
 * `${code}: ${message}` shape; a non-`NarratorrError` throw is a generic 'handoff failed'.
 */
export function handoffFailureReason(err: unknown): string {
  if (err instanceof NarratorrError) {
    return HANDOFF_FAILURE_REASONS[err.upstreamCode] ?? `${err.upstreamCode}: ${err.message}`;
  }
  return 'handoff failed';
}

/**
 * Friendly reason for a book whose status maps to `failed` (`failed` / `missing`). Any
 * other status shouldn't reach here (only `failed`/`missing` collapse to a failed request),
 * but it degrades to a readable `book ${status}` string rather than throwing.
 */
export function bookStatusFailureReason(status: V1Book['status']): string {
  switch (status) {
    case 'failed':
      return 'Download failed upstream.';
    case 'missing':
      return 'No source found upstream.';
    default:
      return `book ${status}`;
  }
}
