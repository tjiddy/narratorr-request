import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { CookieSerializeOptions } from '@fastify/cookie';
import type { AppConfig } from '../config.js';
import type { UserService } from '../services/user.service.js';
import type { AuthUser } from '../types.js';
import { createSessionToken, verifySessionToken, SESSION_TTL_MS } from '../util/session.js';
import { accountPending, accountRejected, forbidden, unauthorized } from '../util/errors.js';
import { isApprovedUser } from '../../shared/schemas/user.js';

export const SESSION_COOKIE = 'nreq_session';

export interface AuthDeps {
  config: AppConfig;
  users: UserService;
}

export function sessionCookieOptions(config: AppConfig): CookieSerializeOptions {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    // Gated on behindTls (not isProd): a prod plain-HTTP deploy (BEHIND_TLS=false) must NOT set
    // Secure, or the browser refuses to store/send the cookie over http:// and login never
    // persists. Defaults to isProd, so the prod-behind-TLS path is unchanged (still Secure).
    secure: config.behindTls,
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  };
}

/** Issue a session cookie for a user (called by the OIDC callback / bypass login). */
export function setSessionCookie(reply: FastifyReply, config: AppConfig, user: { id: number; publicId: string }): void {
  const token = createSessionToken({ uid: user.id, pid: user.publicId }, config.sessionSecret);
  reply.setCookie(SESSION_COOKIE, token, sessionCookieOptions(config));
}

export function clearSessionCookie(reply: FastifyReply, config: AppConfig): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/', ...(config.behindTls ? { secure: true } : {}) });
}

/**
 * Attaches `request.user` when a valid session exists. Does NOT enforce auth —
 * public routes (health, auth flow) must stay reachable. Enforcement is per-route
 * via `requireUser` / `requireAdmin`.
 *
 * In AUTH_BYPASS mode every request is the seeded dev admin (cached after first
 * load), so the whole app is usable without the Plex bridge.
 */
async function authPluginInner(app: FastifyInstance, deps: AuthDeps): Promise<void> {
  let bypassUser: AuthUser | null = null;

  app.addHook('onRequest', async (request: FastifyRequest) => {
    if (deps.config.authMode === 'bypass') {
      if (!bypassUser) {
        const admin = await deps.users.ensureDevAdmin();
        bypassUser = deps.users.toAuthUser(admin);
      }
      request.user = bypassUser;
      return;
    }

    const cookie = request.cookies?.[SESSION_COOKIE];
    if (!cookie) return;
    const payload = verifySessionToken(cookie, deps.config.sessionSecret);
    if (!payload) return;
    const row = await deps.users.getById(payload.uid);
    if (row) request.user = deps.users.toAuthUser(row);
  });
}

export const authPlugin = fp(authPluginInner, { name: 'auth' });

/** Throw 401 unless the request is authenticated; returns the user otherwise. */
export function requireUser(request: FastifyRequest): AuthUser {
  if (!request.user) throw unauthorized();
  return request.user;
}

/**
 * Throw 401/403 unless the request is an authenticated, *approved* user. Admins are
 * always treated as active (they can't be locked out by the approval queue). This is
 * the authorization boundary for every user-facing data route — authentication alone
 * (a session for a pending/rejected account) is not enough to act.
 */
export function requireActiveUser(request: FastifyRequest): AuthUser {
  const user = requireUser(request);
  // The decision itself lives in `isApprovedUser` (shared) — this function owns only the
  // ENFORCEMENT (which error a rejected caller gets). The client gates its active-user-only
  // requests on the same predicate, so the two can't drift.
  if (isApprovedUser(user)) return user;
  throw user.status === 'rejected' ? accountRejected() : accountPending();
}

/** Throw 401/403 unless the request is an authenticated admin. */
export function requireAdmin(request: FastifyRequest): AuthUser {
  const user = requireUser(request);
  if (user.role !== 'admin') throw forbidden('Admin only');
  return user;
}
