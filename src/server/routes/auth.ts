import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { AppDeps } from '../services/deps.js';
import type { UpsertResult } from '../services/user.service.js';
import {
  meDtoSchema,
  authProvidersDtoSchema,
  localCredentialsSchema,
  updateMeBodySchema,
  sanitizeNotifyOn,
  hasDeliverableContact,
  type MeDto,
} from '../../shared/schemas/user.js';
import type { UserRow } from '../../db/schema.js';
import { selectEmailSource } from '../services/notifications/requester-email.js';
import { requireUser, setSessionCookie, clearSessionCookie } from '../plugins/auth.js';
import { hashPassword, verifyPassword } from '../util/password.js';
import { badRequest, conflict, notFound, unauthorized } from '../util/errors.js';

const okSchema = z.object({ ok: z.literal(true) });

export function registerAuthRoutes(app: FastifyInstance, deps: AppDeps): void {
  const a = app.withTypeProvider<ZodTypeProvider>();
  const postLoginRedirect = deps.config.isProd ? '/' : deps.config.corsOrigin;

  // Fire the "new user awaiting approval" heads-up — but ONLY for a freshly-created
  // identity that landed `pending`. This excludes the first-user-auto-admin and any
  // BOOTSTRAP_ADMIN (those come back `active`) and returning logins (`created` false),
  // so an admin is pinged once per genuine signup, never on a repeat sign-in.
  // Fire-and-forget: the dispatcher never throws and we never block login on delivery.
  const notifyIfPending = ({ user, created }: UpsertResult): void => {
    if (created && user.status === 'pending') {
      void deps.notifier.notify({
        event: 'user.pending',
        user: {
          publicId: user.publicId,
          username: user.username,
          email: user.email,
          authProvider: user.authProvider,
        },
      });
    }
  };

  // Opt-in rate limit on the auth endpoints (the limiter is global:false, so polling
  // routes are never throttled). Keyed on IP + username (see index.ts) and resolved
  // against the real client IP via TRUSTED_PROXIES behind a proxy. Disabled under AUTH_BYPASS
  // (every request is the dev admin there — a limiter would only let a dev self-lockout).
  // CSRF on these state-changing POSTs rests on the session cookie's SameSite=Lax, which
  // blocks cross-site POSTs from carrying it; the single-origin CORS policy backs it up.
  const rl = (max: number) =>
    deps.config.authMode === 'bypass' ? {} : { config: { rateLimit: { max, timeWindow: '1 minute' } } };

  // Build the self-scoped `/api/me` DTO: the user + rolling quota usage + the caller's own
  // requester-notification opt-in set and whether email delivery is currently available (a
  // non-null contact AND a usable email-notifier SMTP source). `emailNotifyAvailable` drives the
  // client's opt-in enabled state + discoverability nudge; the opt-in SET is stored regardless
  // (storage-permissive — Design #4). Shared by GET (reads the row) and PATCH (echoes the write).
  const buildMeDto = async (row: UserRow): Promise<MeDto> => {
    const quota = await deps.requests.quotaUsage(row.id, deps.requests.resolveQuota(row));
    const emailNotifyAvailable =
      hasDeliverableContact(row.email) && selectEmailSource(await deps.connectorSettings.getNotificationsConfig()) !== null;
    return { ...deps.users.toDto(row), quota, notifyOn: sanitizeNotifyOn(row.notifyOn), emailNotifyAvailable };
  };

  // Current user + rolling quota usage + own opt-in set.
  a.get('/api/me', { schema: { response: { 200: meDtoSchema } } }, async (request) => {
    const user = requireUser(request);
    const row = await deps.users.getById(user.id);
    if (!row) throw badRequest('NO_USER', 'session user no longer exists');
    return buildMeDto(row);
  });

  // Update the caller's own account preferences: requester-notification opt-in set AND/OR contact
  // email (issue #131). Self-scoped — no target id, cannot mutate another user (requireUser gates it;
  // the manifest test asserts the guard). Both fields are INDEPENDENT and OPTIONAL. `notifyOn`:
  // storage-permissive — a value outside NOTIFIABLE_TRANSITIONS is a 400 (Zod), but enabling without
  // a usable email/SMTP is NOT a 403 (delivery gates at send time). `email`: omitted = no change,
  // `null` clears the contact, a non-empty value is normalized + deliverability-validated by
  // `contactEmailSchema` (invalid / "" → 400). The write touches only `notify_on` / `email`, never
  // the login `authSubject`. Apply each provided field, then re-read for a consistent DTO echo.
  a.patch('/api/me', { schema: { body: updateMeBodySchema, response: { 200: meDtoSchema } } }, async (request) => {
    const user = requireUser(request);
    const { notifyOn, email } = request.body;
    if (email !== undefined) await deps.users.setContactEmail(user.id, email);
    if (notifyOn !== undefined) await deps.users.setNotifyOn(user.id, notifyOn);
    const row = await deps.users.getById(user.id);
    if (!row) throw badRequest('NO_USER', 'session user no longer exists');
    return buildMeDto(row);
  });

  // Server-driven login screen. The client renders the password form when `local` is
  // true and one button per configured OIDC provider. PUBLIC (pre-auth).
  a.get('/api/auth/providers', { schema: { response: { 200: authProvidersDtoSchema } } }, async () => ({
    local: deps.config.localAuth,
    providers: [...deps.oidc.values()].map(({ config }) => ({ id: config.id, label: config.label })),
  }));

  // --- Local email/password (only when enabled) ------------------------------
  if (deps.config.localAuth) {
    // Sign up → create a local identity. New users land `pending` (approval queue);
    // the very first user in any method becomes admin + active (see UserService).
    a.post(
      '/api/auth/local/signup',
      { ...rl(5), schema: { body: localCredentialsSchema, response: { 200: okSchema } } },
      async (request, reply) => {
        const { email, password } = request.body;
        const exists = await deps.users.findLocalByEmail(email);
        // Signup necessarily reveals whether an email is free (every signup form does);
        // accepted low-risk enumeration. Login below stays generic + constant-time.
        if (exists) throw conflict('EMAIL_TAKEN', 'That email is already registered.');
        const passwordHash = await hashPassword(password);
        const result = await deps.users.createLocalUser({ email, passwordHash });
        // Race guard: two concurrent signups for the same email both clear the pre-check
        // above, then one wins the INSERT and the other hits the unique (provider,subject)
        // index — createLocalUser returns the EXISTING row with created=false. For local
        // auth that means the email is taken; we must NOT mint a session, or the losing
        // racer would be logged into the winner's account without its password. (OIDC's
        // return-existing-on-conflict is correct there — same subject is the same person.)
        if (!result.created) throw conflict('EMAIL_TAKEN', 'That email is already registered.');
        setSessionCookie(reply, deps.config, result.user);
        notifyIfPending(result);
        return { ok: true as const };
      },
    );

    // Log in → verify the password. Generic error + a dummy KDF run when the user is
    // missing (or is an OIDC identity with no hash) so timing/response don't leak which
    // emails are registered.
    a.post(
      '/api/auth/local/login',
      { ...rl(10), schema: { body: localCredentialsSchema, response: { 200: okSchema } } },
      async (request, reply) => {
        const { email, password } = request.body;
        const user = await deps.users.findLocalByEmail(email);
        const ok = await verifyPassword(password, user?.passwordHash ?? null);
        if (!user || !ok) throw unauthorized('Invalid email or password');
        setSessionCookie(reply, deps.config, user);
        return { ok: true as const };
      },
    );
  }

  // --- Generic OIDC (one route pair for every configured provider) -----------
  // Begin login: redirect to the provider's authorization endpoint. Rate-limited (it
  // mints an in-memory PKCE entry per call) so an unauthenticated loop can't inflate it.
  a.get('/api/auth/oidc/:provider/login', { ...rl(30) }, async (request, reply) => {
    const { provider } = request.params as { provider: string };
    const entry = deps.oidc.get(provider);
    if (!entry) throw notFound('unknown auth provider');
    return reply.redirect(await entry.service.buildAuthUrl());
  });

  // OAuth callback — exchange code, upsert the user (→ approval queue), mint a session.
  a.get('/api/auth/oidc/:provider/callback', async (request, reply) => {
    const { provider } = request.params as { provider: string };
    const entry = deps.oidc.get(provider);
    if (!entry) throw notFound('unknown auth provider');
    try {
      // Reconstruct the callback URL from the CONFIGURED redirect URI plus only the
      // incoming query (code/state) — never from the attacker-controllable Host header.
      const callbackUrl = new URL(entry.config.redirectUri);
      callbackUrl.search = new URL(request.url, callbackUrl.origin).search;
      const profile = await entry.service.handleCallback(callbackUrl.toString());
      const result = await deps.users.upsertFromOidc(provider, profile);
      setSessionCookie(reply, deps.config, result.user);
      notifyIfPending(result);
      return await reply.redirect(postLoginRedirect);
    } catch (err) {
      // This is a top-level browser navigation — a raw JSON error page is a dead end.
      // Log the detail and bounce back to the login screen with a generic error flag.
      request.log.warn({ err, provider }, 'OIDC callback failed');
      const sep = postLoginRedirect.includes('?') ? '&' : '?';
      return reply.redirect(`${postLoginRedirect}${sep}login_error=oidc`);
    }
  });

  // Logout — clear the session cookie.
  a.post('/api/auth/logout', { schema: { response: { 200: okSchema } } }, async (_request, reply) => {
    clearSessionCookie(reply, deps.config);
    return reply.send({ ok: true as const });
  });
}
