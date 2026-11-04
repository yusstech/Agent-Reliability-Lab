// Shared HTTP plumbing for the mock providers: error envelope, scenario routes, and the
// two ways a timeout can manifest (ADR-0008 §2).
import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { FaultConfigError, type FaultEngine, type FaultRule } from './faults.ts';

export type ProviderErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_FAILED'
  | 'MISSING_ACTING_CUSTOMER'
  | 'NOT_FOUND'
  | 'MUTATION_NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'PROVIDER_REJECTED'
  | 'SHIPMENT_DISPATCHED'
  | 'NOT_SUPPORTED'
  | 'SERVICE_UNAVAILABLE'
  | 'INTERNAL';

export class ProviderError extends Error {
  readonly statusCode: number;
  readonly code: ProviderErrorCode;
  readonly details: unknown;
  constructor(statusCode: number, code: ProviderErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ProviderError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ProviderError(
      400,
      'VALIDATION_FAILED',
      'request is invalid',
      result.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })),
    );
  }
  return result.data;
}

export interface ProviderApp {
  app: FastifyInstance;
  /** Ends a request the way a timeout fault says it should. The caller must return afterwards. */
  failTransport(request: FastifyRequest, reply: FastifyReply, rule: FaultRule): void;
}

export function createProviderApp(name: string, engine: FaultEngine<unknown>, devRoutes: boolean): ProviderApp {
  const app = Fastify({
    logger: false,
    bodyLimit: 8 * 1024,
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    // Hung connections must not keep the server open on close.
    forceCloseConnections: true,
  });
  app.removeContentTypeParser('text/plain');

  const hung = new Map<Socket, NodeJS.Timeout>();
  app.addHook('onClose', async () => {
    for (const [socket, timer] of hung) {
      clearTimeout(timer);
      socket.destroy();
    }
    hung.clear();
  });

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
    reply.header('x-provider', name);
  });

  app.setErrorHandler((err: FastifyError | ProviderError, request, reply) => {
    let e: ProviderError;
    if (err instanceof ProviderError) e = err;
    else if (err.statusCode !== undefined && err.statusCode >= 400 && err.statusCode < 500) e = new ProviderError(err.statusCode, 'BAD_REQUEST', 'request could not be processed');
    else e = new ProviderError(500, 'INTERNAL', 'internal error');
    return reply.status(e.statusCode).send({
      error: { code: e.code, message: e.message, request_id: request.id, ...(e.details ? { details: e.details } : {}) },
    });
  });
  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'route not found', request_id: request.id } }),
  );

  if (devRoutes) {
    // Scenario control surface: local research use only (ADR-0008 §8).
    app.put('/_dev/scenario', async (request) => {
      try {
        engine.load(request.body);
      } catch (err) {
        if (err instanceof FaultConfigError) throw new ProviderError(400, 'VALIDATION_FAILED', err.message, err.details);
        throw err;
      }
      return engine.state();
    });
    app.delete('/_dev/scenario', async () => {
      engine.reset();
      return engine.state();
    });
    app.get('/_dev/state', async () => engine.state());
  }

  function failTransport(request: FastifyRequest, reply: FastifyReply, rule: FaultRule): void {
    reply.hijack();
    const socket = request.raw.socket;
    if (rule.params.manifest === 'reset') {
      socket.destroy();
      return;
    }
    const timer = setTimeout(() => {
      hung.delete(socket);
      socket.destroy();
    }, rule.params.hang_ms);
    timer.unref();
    hung.set(socket, timer);
    socket.once('close', () => {
      clearTimeout(timer);
      hung.delete(socket);
    });
  }

  return { app, failTransport };
}
