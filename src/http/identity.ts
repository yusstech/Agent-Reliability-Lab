// MOCK authentication (ADR-0004). Resolves a bearer token to a customer via a
// server-side session table. This is the *only* place identity is established;
// handlers receive an Identity value and never read headers or body fields for it.
import type { FastifyRequest } from 'fastify';
import type pg from 'pg';
import { hashToken } from '../security/token-hash.ts';
import { AppError } from './errors.ts';

export interface Identity {
  customerId: string;
  authMode: 'mock_session';
}

// Auth scheme names are case-insensitive (RFC 9110 §11.1); the token itself is not.
const BEARER = /^[Bb][Ee][Aa][Rr][Ee][Rr] ([A-Za-z0-9_-]{8,256})$/;

// One message for every failure so callers cannot probe which tokens exist.
const unauthenticated = () => new AppError(401, 'UNAUTHENTICATED', 'a valid session is required');

export async function resolveIdentity(pool: pg.Pool, request: FastifyRequest): Promise<Identity> {
  const match = BEARER.exec(request.headers.authorization ?? '');
  if (!match?.[1]) throw unauthenticated();
  let rows: { customer_id: string }[];
  try {
    ({ rows } = await pool.query<{ customer_id: string }>(
      'SELECT customer_id FROM identity.mock_sessions WHERE token_sha256 = $1',
      [hashToken(match[1])],
    ));
  } catch (err) {
    request.log.warn({ err }, 'session lookup failed');
    throw new AppError(503, 'DEPENDENCY_UNAVAILABLE', 'database unavailable');
  }
  const row = rows[0];
  if (!row) throw unauthenticated();
  return { customerId: row.customer_id, authMode: 'mock_session' };
}
