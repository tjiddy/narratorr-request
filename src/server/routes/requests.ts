import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { AppDeps } from '../services/deps.js';
import {
  createRequestBodySchema,
  requestDtoSchema,
  requestListQuerySchema,
} from '../../shared/schemas/request.js';
import { listEnvelope, prefixedId } from '../../shared/schemas/v1/common.js';
import { requireActiveUser } from '../plugins/auth.js';
import { forbidden, notFound } from '../util/errors.js';

const pidParams = z.object({ publicId: prefixedId('rq') });
const requestListSchema = listEnvelope(requestDtoSchema);

export function registerRequestRoutes(app: FastifyInstance, deps: AppDeps): void {
  const a = app.withTypeProvider<ZodTypeProvider>();

  // Create a request (the requester is always the authenticated user).
  a.post(
    '/api/requests',
    { schema: { body: createRequestBodySchema, response: { 200: requestDtoSchema, 201: requestDtoSchema } } },
    async (request, reply) => {
      const user = requireActiveUser(request);
      const { row, created } = await deps.requests.create(user.id, request.body);

      // Notify the admin only for a genuinely new request awaiting review —
      // auto-approved ones (admins / flagged users) need no action. Fire-and-forget:
      // the dispatcher never throws, and we don't block the response on delivery.
      if (created && row.status === 'pending') {
        void deps.notifier.notify({
          event: 'request.created',
          request: {
            publicId: row.publicId,
            title: row.title,
            author: row.author,
            asin: row.asin,
            coverUrl: row.coverUrl,
          },
          requester: { username: user.username },
        });
      }

      const dto = deps.requests.toDto(row, { publicId: user.publicId, username: user.username });
      return reply.status(created ? 201 : 200).send(dto);
    },
  );

  // List the caller's own requests.
  a.get(
    '/api/requests',
    { schema: { querystring: requestListQuerySchema, response: { 200: requestListSchema } } },
    async (request) => {
      const user = requireActiveUser(request);
      return deps.requests.list({
        userId: user.id,
        ...(request.query.status !== undefined ? { status: request.query.status } : {}),
        limit: request.query.limit,
        offset: request.query.offset,
      });
    },
  );

  // Fetch a single request — owner or admin only.
  a.get(
    '/api/requests/:publicId',
    { schema: { params: pidParams, response: { 200: requestDtoSchema } } },
    async (request) => {
      const user = requireActiveUser(request);
      const row = await deps.requests.getByPublicId(request.params.publicId);
      if (!row) throw notFound('request not found');
      if (row.userId !== user.id && user.role !== 'admin') throw forbidden();
      const requester = await deps.users.getById(row.userId);
      return deps.requests.toDto(row, {
        publicId: requester?.publicId ?? user.publicId,
        username: requester?.username ?? user.username,
      });
    },
  );
}
