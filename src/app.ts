import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import type pg from 'pg';
import { AppError, envelope } from './http/errors.ts';
import { type Identity, resolveIdentity } from './http/identity.ts';
import { AddressChangeRequestSchema, parseBody } from './http/schemas.ts';

export interface AppOptions {
  pool: pg.Pool;
  logger?: FastifyServerOptions['logger'];
}

const BODY_LIMIT_BYTES = 16 * 1024;

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the /v1 onRequest hook, before the body is read. */
    identity: Identity | null;
  }
}

/** For handlers inside the authenticated scope; the hook guarantees it is set. */
function identityOf(request: FastifyRequest): Identity {
  if (!request.identity) throw new AppError(500, 'INTERNAL', 'internal error');
  return request.identity;
}

/** Maps framework-level errors (parsing, limits) onto the stable envelope. */
function fromFrameworkError(err: FastifyError): AppError {
  switch (err.code) {
    case 'FST_ERR_CTP_INVALID_MEDIA_TYPE':
      return new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'content-type must be application/json');
    case 'FST_ERR_CTP_BODY_TOO_LARGE':
      return new AppError(413, 'PAYLOAD_TOO_LARGE', `request body exceeds ${BODY_LIMIT_BYTES} bytes`);
    case 'FST_ERR_CTP_EMPTY_JSON_BODY':
    case 'FST_ERR_CTP_INVALID_JSON_BODY':
      return new AppError(400, 'MALFORMED_JSON', 'request body is not valid JSON');
  }
  if (err instanceof SyntaxError && err.statusCode === 400) {
    return new AppError(400, 'MALFORMED_JSON', 'request body is not valid JSON');
  }
  if (err.statusCode === 404) return new AppError(404, 'ROUTE_NOT_FOUND', 'route not found');
  if (err.statusCode === 405) return new AppError(405, 'METHOD_NOT_ALLOWED', 'method not allowed');
  // Any other framework client error keeps its status; it is not a server fault.
  if (err.statusCode !== undefined && err.statusCode >= 400 && err.statusCode < 500) {
    return new AppError(err.statusCode, 'BAD_REQUEST', 'request could not be processed');
  }
  return new AppError(500, 'INTERNAL', 'internal error');
}

export function buildApp({ pool, logger = false }: AppOptions): FastifyInstance {
  const app = Fastify({
    logger,
    bodyLimit: BODY_LIMIT_BYTES,
    genReqId: () => randomUUID(),
    requestIdHeader: false, // never trust a client-supplied request id
  });

  // JSON-only API: drop Fastify's default text/plain parser so other types get a 415.
  app.removeContentTypeParser('text/plain');

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  app.setErrorHandler((err: FastifyError | AppError, request, reply) => {
    const appError = err instanceof AppError ? err : fromFrameworkError(err);
    if (appError.statusCode >= 500) request.log.error({ err }, 'request failed');
    return reply.status(appError.statusCode).send(envelope(appError, request.id));
  });

  app.setNotFoundHandler((request, reply) => {
    return reply.status(404).send(envelope(new AppError(404, 'ROUTE_NOT_FOUND', 'route not found'), request.id));
  });

  app.get('/health', async (_request, reply) => {
    try {
      const { rows } = await pool.query<{ version: string }>(
        'SELECT version FROM public.schema_migrations ORDER BY version DESC LIMIT 1',
      );
      return { status: 'ok', database: 'ok', schema_version: rows[0]?.version ?? null };
    } catch (err) {
      reply.log.warn({ err }, 'health check: database unavailable');
      throw new AppError(503, 'DEPENDENCY_UNAVAILABLE', 'database unavailable');
    }
  });

  app.decorateRequest('identity', null);

  // Every /v1 route is authenticated in onRequest, which runs before the body is parsed,
  // so unauthenticated callers get 401 regardless of body, content type or size.
  app.register(async (v1) => {
    v1.addHook('onRequest', async (request) => {
      request.identity = await resolveIdentity(pool, request);
    });

    // Echoes the server-derived identity. Demonstrates that identity comes from the session.
    v1.get('/session', async (request) => {
      const identity = identityOf(request);
      return { customer_id: identity.customerId, auth_mode: identity.authMode };
    });

    // Phase 01 ships the contract boundary only: authentication, then strict validation.
    // Ownership, eligibility, idempotent operation creation and confirmation are Phase 03.
    v1.post('/address-change-requests', async (request) => {
      parseBody(AddressChangeRequestSchema, request.body);
      throw new AppError(501, 'NOT_IMPLEMENTED', 'address-change execution is implemented in Phase 03');
    });
  }, { prefix: '/v1' });

  return app;
}
