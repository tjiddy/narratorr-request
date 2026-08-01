import fp from 'fastify-plugin';
import type { FastifyError, FastifyInstance } from 'fastify';
import { ApiError } from '../util/errors.js';
import { NarratorrError } from '../services/narratorr-client.js';
import { errorBody } from '../../shared/schemas/v1/common.js';

function isValidationError(error: FastifyError | Error): boolean {
  if ('validation' in error && (error as FastifyError).validation) return true;
  const code = (error as { code?: string }).code;
  return code === 'FST_ERR_VALIDATION';
}

/**
 * Body-parser failures Fastify raises BEFORE any route code runs. None of them is an `ApiError`,
 * none carries `error.validation`, and none is a 429 — so without this clause every one of them
 * fell through to `500 INTERNAL`, which is wrong for what are plainly client mistakes (a malformed
 * JSON login body 500'd).
 *
 * Fastify's own status is preserved and paired with a stable app code and OUR message — never
 * Fastify's raw text, per this handler's existing no-leak doctrine. The set is an ALLOWLIST: an
 * unlisted `FST_ERR_CTP_*` (e.g. `FST_ERR_CTP_INVALID_PARSE_TYPE`, a wiring/programmer error)
 * keeps falling through to 500.
 *
 * This is a shared-plugin change, so it corrects the same latent defect on every body-accepting
 * route, not just the one that surfaced it. That is deliberate and strictly more correct.
 */
const PARSER_ERROR_ANSWERS: Readonly<Record<string, { status: number; code: string; message: string }>> = {
  FST_ERR_CTP_EMPTY_JSON_BODY: { status: 400, code: 'BAD_REQUEST', message: 'A JSON request body is required.' },
  FST_ERR_CTP_INVALID_JSON_BODY: { status: 400, code: 'BAD_REQUEST', message: 'The request body is not valid JSON.' },
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: { status: 400, code: 'BAD_REQUEST', message: 'The request body did not match its Content-Length.' },
  FST_ERR_CTP_BODY_TOO_LARGE: { status: 413, code: 'PAYLOAD_TOO_LARGE', message: 'The request body is too large.' },
  FST_ERR_CTP_INVALID_MEDIA_TYPE: { status: 415, code: 'UNSUPPORTED_MEDIA_TYPE', message: 'That content type is not supported.' },
};

function parserErrorAnswer(error: FastifyError | Error): { status: number; code: string; message: string } | null {
  const code = (error as { code?: unknown }).code;
  if (typeof code !== 'string' || !Object.hasOwn(PARSER_ERROR_ANSWERS, code)) return null;
  const answer = PARSER_ERROR_ANSWERS[code];
  if (!answer) return null;
  const status = (error as { statusCode?: unknown }).statusCode;
  return typeof status === 'number' ? { ...answer, status } : answer;
}

/**
 * Translates thrown errors into the v1 error envelope `{ error: { code, message } }`.
 * Typed `ApiError`s carry their own status/code; Fastify/Zod validation failures
 * become 400 BAD_REQUEST; anything else is a 500 with a generic message (no leak).
 */
async function errorHandlerInner(app: FastifyInstance): Promise<void> {
  app.setErrorHandler((error: FastifyError | Error, request, reply) => {
    if (error instanceof ApiError) {
      if (error.statusCode >= 500) {
        request.log.error({ err: error, code: error.code }, error.message);
        // "Narratorr not configured" is a deliberately user-facing, leak-free message
        // (the normal state on a fresh install) — let it through the 5xx scrub with a
        // 503 so the client shows "set it up in Settings" instead of "try again".
        if (error instanceof NarratorrError && error.upstreamCode === 'NOT_CONFIGURED') {
          return reply.status(503).send(errorBody('NOT_CONFIGURED', error.message));
        }
        // Otherwise keep the machine-readable code but never leak internal/upstream
        // detail (e.g. NarratorrError's "Narratorr GET … failed") to the browser.
        const publicMessage =
          error.statusCode === 502 || error.statusCode === 503 || error.statusCode === 504
            ? 'A required service is temporarily unavailable. Please try again.'
            : 'Internal server error';
        return reply.status(error.statusCode).send(errorBody(error.code, publicMessage));
      }
      request.log.warn({ code: error.code }, error.message);
      return reply.status(error.statusCode).send(errorBody(error.code, error.message));
    }

    if (isValidationError(error)) {
      request.log.warn({ err: error }, 'validation error');
      return reply.status(400).send(errorBody('BAD_REQUEST', error.message));
    }

    const parserAnswer = parserErrorAnswer(error);
    if (parserAnswer) {
      request.log.warn({ code: parserAnswer.code }, 'request body could not be parsed');
      return reply.status(parserAnswer.status).send(errorBody(parserAnswer.code, parserAnswer.message));
    }

    // Rate-limit rejections arrive as a plain error carrying statusCode 429 (the limiter
    // normally formats its own response via errorResponseBuilder; this is belt-and-braces
    // so a throttle can never masquerade as a 500 and skew 5xx dashboards).
    if ((error as { statusCode?: number }).statusCode === 429) {
      request.log.warn({ err: error }, 'rate limited');
      return reply.status(429).send(errorBody('RATE_LIMITED', 'Too many attempts. Please wait and try again.'));
    }

    request.log.error({ err: error }, error.message || 'Unhandled error');
    return reply.status(500).send(errorBody('INTERNAL', 'Internal server error'));
  });
}

export const errorHandlerPlugin = fp(errorHandlerInner, { name: 'error-handler' });
