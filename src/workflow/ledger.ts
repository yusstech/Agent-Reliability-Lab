// Durable operation ledger (ADR-0009). Every status change goes through assertTransition
// with the visited history read from the event log, inside the caller's transaction.
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { assertTransition, type DualSystemVerification, type OperationStatus } from '../domain/operation-state.ts';

export interface OperationRow {
  id: string;
  customer_id: string;
  idempotency_key: string;
  request_fingerprint: string;
  order_id: string;
  target_address_id: string;
  status: OperationStatus;
  attempts: number;
  created_at: Date;
  updated_at: Date;
  carrier_ref: string | null;
  original_address_id: string | null;
  validated_order_version: number | null;
  public_reason: string | null;
  step_attempts: number;
  next_attempt_at: Date | null;
  lease_token: string | null;
  lease_expires_at: Date | null;
}

export interface EventInput {
  step: string;
  reason_code: string;
  from_status?: OperationStatus | null;
  to_status?: OperationStatus | null;
  provider_reference?: string | null;
  result?: string | null;
  error_code?: string | null;
  detail?: Record<string, unknown> | null;
}

export interface EventRow extends Required<EventInput> {
  operation_id: string;
  sequence: number;
  created_at: Date;
}

export interface TransitionEvidence {
  verification?: DualSystemVerification;
  compensation?: DualSystemVerification;
  detail?: Record<string, unknown>;
}

export const newOperationId = () => `op_${randomBytes(12).toString('hex')}`;

export async function appendEvent(client: pg.PoolClient, operationId: string, e: EventInput): Promise<void> {
  await client.query(
    `INSERT INTO ledger.operation_events
       (operation_id, sequence, step, from_status, to_status, reason_code, provider_reference, result, error_code, detail)
     VALUES ($1, (SELECT coalesce(max(sequence), 0) + 1 FROM ledger.operation_events WHERE operation_id = $1),
             $2, $3, $4, $5, $6, $7, $8, $9)`,
    [operationId, e.step, e.from_status ?? null, e.to_status ?? null, e.reason_code, e.provider_reference ?? null, e.result ?? null, e.error_code ?? null, e.detail ?? null],
  );
}

export async function listEvents(db: pg.Pool | pg.PoolClient, operationId: string): Promise<EventRow[]> {
  const { rows } = await db.query<EventRow>(
    `SELECT operation_id, sequence, step, from_status, to_status, reason_code, provider_reference, result, error_code, detail, created_at
     FROM ledger.operation_events WHERE operation_id = $1 ORDER BY sequence`,
    [operationId],
  );
  return rows;
}

/** Changes status after validating the transition against the full visited history. */
export async function applyTransition(
  client: pg.PoolClient,
  op: OperationRow,
  to: OperationStatus,
  reasonCode: string,
  evidence: TransitionEvidence = {},
): Promise<OperationRow> {
  const visited = (await listEvents(client, op.id)).flatMap((e) => (e.to_status ? [e.to_status] : []));
  assertTransition({
    from: op.status,
    to,
    reasonCode,
    targetAddressId: op.target_address_id,
    visited,
    verification: evidence.verification,
    originalAddressId: op.original_address_id ?? undefined,
    compensation: evidence.compensation,
  });
  const { rows } = await client.query<OperationRow>(
    `UPDATE ledger.operations
     SET status = $2, public_reason = $3, step_attempts = 0, next_attempt_at = NULL, updated_at = now()
     WHERE id = $1 RETURNING *`,
    [op.id, to, reasonCode],
  );
  const detail = { ...evidence.detail, ...(evidence.verification ? { verification: evidence.verification } : {}), ...(evidence.compensation ? { compensation: evidence.compensation } : {}) };
  await appendEvent(client, op.id, {
    step: 'TRANSITION',
    from_status: op.status,
    to_status: to,
    reason_code: reasonCode,
    detail: Object.keys(detail).length ? detail : null,
  });
  return rows[0] as OperationRow;
}

export async function inTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export class LeaseLostError extends Error {
  constructor(operationId: string) {
    super(`lease on ${operationId} was lost; another worker owns it now`);
    this.name = 'LeaseLostError';
  }
}

/** Runs fn only if this worker still holds the lease (fencing, ADR-0009 §2). */
export async function fenced<T>(pool: pg.Pool, operationId: string, leaseToken: string, fn: (client: pg.PoolClient, op: OperationRow) => Promise<T>): Promise<T> {
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<OperationRow>('SELECT * FROM ledger.operations WHERE id = $1 AND lease_token = $2 FOR UPDATE', [operationId, leaseToken]);
    const op = rows[0];
    if (!op) throw new LeaseLostError(operationId);
    return fn(client, op);
  });
}

const CLAIMABLE = `('QUEUED', 'UPDATING_ORDER', 'UPDATING_CARRIER', 'VERIFYING', 'COMPENSATING', 'PENDING_RECONCILIATION')`;

/** Claims the oldest runnable operation (or a specific one) under a fresh lease. */
export async function claimNext(pool: pg.Pool, leaseToken: string, leaseMs: number, operationId: string | null = null): Promise<OperationRow | undefined> {
  const { rows } = await pool.query<OperationRow>(
    `UPDATE ledger.operations o
     SET lease_token = $1, lease_expires_at = now() + make_interval(secs => $2::float8 / 1000), attempts = o.attempts + 1
     WHERE o.id = (
       SELECT q.id FROM ledger.operations q
       WHERE (q.status IN ${CLAIMABLE}
              OR (q.status = 'NEEDS_CONFIRMATION' AND EXISTS (
                    SELECT 1 FROM ledger.confirmations c
                    WHERE c.operation_id = q.id AND c.confirmed_at IS NULL AND c.expires_at <= now())))
         AND (q.lease_expires_at IS NULL OR q.lease_expires_at <= now())
         AND (q.next_attempt_at IS NULL OR q.next_attempt_at <= now())
         AND ($3::text IS NULL OR q.id = $3)
       ORDER BY q.created_at, q.id
       FOR UPDATE SKIP LOCKED
       LIMIT 1)
     RETURNING o.*`,
    [leaseToken, leaseMs, operationId],
  );
  return rows[0];
}

export async function releaseLease(client: pg.PoolClient, operationId: string, nextAttemptInMs: number | null): Promise<void> {
  await client.query(
    `UPDATE ledger.operations SET lease_token = NULL, lease_expires_at = NULL,
       next_attempt_at = CASE WHEN $2::float8 IS NULL THEN NULL ELSE now() + make_interval(secs => $2::float8 / 1000) END,
       updated_at = now()
     WHERE id = $1`,
    [operationId, nextAttemptInMs],
  );
}
