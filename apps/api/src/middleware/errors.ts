import type { FastifyError, FastifyInstance } from 'fastify';
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from 'fastify-type-provider-zod';
import type { ErrorResponse } from '@queueforge/shared';

/** An expected failure with a stable machine-readable code and an HTTP status. */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (what: string) => new AppError(404, 'NOT_FOUND', `${what} not found`);
export const conflict = (code: string, message: string) => new AppError(409, code, message);

export class RedisUnavailableError extends AppError {
  constructor(reason: string) {
    super(503, 'REDIS_UNAVAILABLE', `The job store is temporarily unavailable (${reason}). Retry later.`);
  }
}

const REDIS_ERROR_PATTERNS = [
  /Stream isn't writeable/i,
  /enableOfflineQueue/i,
  /Connection is closed/i,
  /max retries per request/i,
  /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH/,
];

export function isRedisConnectivityError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'MaxRetriesPerRequestError') return true;
  return REDIS_ERROR_PATTERNS.some((p) => p.test(err.message));
}

/** Bound a Redis-backed operation so an outage produces a fast 503 instead of a hung request. */
export async function withRedisTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RedisUnavailableError(`no response within ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } catch (err) {
    if (isRedisConnectivityError(err)) throw new RedisUnavailableError('connection error');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function registerErrorHandling(app: FastifyInstance, opts: { exposeErrorDetails: boolean }) {
  const send = (statusCode: number, body: Omit<ErrorResponse, 'requestId'>, requestId: string) => ({
    statusCode,
    payload: { ...body, requestId } satisfies ErrorResponse,
  });

  app.setErrorHandler((err: FastifyError, request, reply) => {
    let out: ReturnType<typeof send>;
    if (hasZodFastifySchemaValidationErrors(err)) {
      out = send(
        400,
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Request validation failed',
            details: err.validation.map((v) => ({
              path: v.instancePath || '/',
              message: v.message,
              location: err.validationContext,
            })),
          },
        },
        request.id,
      );
    } else if (err instanceof AppError) {
      out = send(err.statusCode, { error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } }, request.id);
    } else if (isRedisConnectivityError(err)) {
      out = send(503, { error: { code: 'REDIS_UNAVAILABLE', message: 'The job store is temporarily unavailable. Retry later.' } }, request.id);
    } else if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      out = send(413, { error: { code: 'PAYLOAD_TOO_LARGE', message: err.message } }, request.id);
    } else if (err.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' || err.code === 'FST_ERR_CTP_EMPTY_JSON_BODY') {
      out = send(415, { error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: err.message } }, request.id);
    } else if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      out = send(err.statusCode, { error: { code: err.code ?? 'BAD_REQUEST', message: err.message } }, request.id);
    } else {
      if (isResponseSerializationError(err)) {
        request.log.error({ err, method: err.method, url: err.url }, 'Response did not match its schema');
      } else {
        request.log.error({ err }, 'Unhandled error');
      }
      // Never leak stack traces or internal messages publicly.
      out = send(
        500,
        { error: { code: 'INTERNAL_ERROR', message: opts.exposeErrorDetails ? err.message : 'Internal server error' } },
        request.id,
      );
    }
    if (out.statusCode >= 500 && out.statusCode !== 503) reply.header('cache-control', 'no-store');
    return reply.status(out.statusCode).send(out.payload);
  });

  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send({
      error: { code: 'ROUTE_NOT_FOUND', message: `Route ${request.method} ${request.url} not found` },
      requestId: request.id,
    } satisfies ErrorResponse),
  );
}
