import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { AppDeps } from '../services/deps.js';
import { decisionBodySchema, requestDtoSchema, requestListQuerySchema } from '../../shared/schemas/request.js';
import { userDtoSchema, updateUserBodySchema } from '../../shared/schemas/user.js';
import { listEnvelope, prefixedId } from '../../shared/schemas/v1/common.js';
import { requireAdmin } from '../plugins/auth.js';
import { badRequest, notFound } from '../util/errors.js';

const pidParams = z.object({ publicId: prefixedId('rq') });
const userPidParams = z.object({ publicId: prefixedId('us') });
const requestListSchema = listEnvelope(requestDtoSchema);
const userListSchema = listEnvelope(userDtoSchema);

export function registerAdminRoutes(app: FastifyInstance, deps: AppDeps): void {
  const a = app.withTypeProvider<ZodTypeProvider>();

  // Admin queue — all users' requests, defaulting to the pending review queue.
  a.get(
    '/api/admin/requests',
    { schema: { querystring: requestListQuerySchema, response: { 200: requestListSchema } } },
    async (request) => {
      requireAdmin(request);
      return deps.requests.list({
        ...(request.query.status !== undefined ? { status: request.query.status } : {}),
        limit: request.query.limit,
        offset: request.query.offset,
      });
    },
  );

  // Approve/deny. Approve immediately hands the request off to Narratorr.
  a.post(
    '/api/admin/requests/:publicId/decision',
    { schema: { params: pidParams, body: decisionBodySchema, response: { 200: requestDtoSchema } } },
    async (request) => {
      const admin = requireAdmin(request);
      const row = await deps.requests.decide(admin.id, request.params.publicId, request.body);
      const requester = await deps.users.getById(row.userId);
      if (!requester) throw notFound('requester not found');
      return deps.requests.toDto(row, {
        publicId: requester.publicId,
        username: requester.username,
      });
    },
  );

  // User management — list everyone (admin only).
  a.get(
    '/api/admin/users',
    { schema: { response: { 200: userListSchema } } },
    async (request) => {
      requireAdmin(request);
      const rows = await deps.users.listAll();
      return { data: rows.map((r) => deps.users.toDto(r)), total: rows.length };
    },
  );

  // Update a user — role, quota override, and/or auto-approve. Self-guard: an admin
  // can never change their OWN role, so the last admin can't be locked out (changing
  // your own quota/auto-approve is harmless and allowed).
  a.patch(
    '/api/admin/users/:publicId',
    { schema: { params: userPidParams, body: updateUserBodySchema, response: { 200: userDtoSchema } } },
    async (request) => {
      const admin = requireAdmin(request);
      // Self-guard: an admin can't change their OWN role or approval status, so the last
      // admin can't lock themselves out (changing your own quota/auto-approve is harmless).
      if (
        request.params.publicId === admin.publicId &&
        (request.body.role !== undefined || request.body.status !== undefined)
      ) {
        throw badRequest('SELF_GUARD', "you can't change your own role or status");
      }
      const updated = await deps.users.updateUser(request.params.publicId, request.body);
      return deps.users.toDto(updated);
    },
  );

  // A single user's request history (admin Users detail view).
  a.get(
    '/api/admin/users/:publicId/requests',
    { schema: { params: userPidParams, querystring: requestListQuerySchema, response: { 200: requestListSchema } } },
    async (request) => {
      requireAdmin(request);
      const user = await deps.users.getByPublicId(request.params.publicId);
      if (!user) throw notFound('user not found');
      return deps.requests.list({
        userId: user.id,
        ...(request.query.status !== undefined ? { status: request.query.status } : {}),
        limit: request.query.limit,
        offset: request.query.offset,
      });
    },
  );
}
