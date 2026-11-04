// Request path for variant A (ADR-0009 §1, §9, §10): validate against the systems of
// record, record the operation, and issue a server-side consent challenge.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';
import type { OperationStatus } from '../domain/operation-state.ts';
import { assertTransition } from '../domain/operation-state.ts';
import { isEligibleForAddressChange } from '../domain/order-eligibility.ts';
import type { Order } from '../domain/types.ts';
import { AppError, type ErrorCode } from '../http/errors.ts';
import type { Identity } from '../http/identity.ts';
import type { AddressChangeRequest } from '../http/schemas.ts';
import { hashToken } from '../security/token-hash.ts';
import type { Providers } from './adapters.ts';
import { type CustomerStatus, customerStatus } from './customer-status.ts';
import { appendEvent, applyTransition, inTransaction, listEvents, newOperationId, type OperationRow } from './ledger.ts';

export interface RequestDeps {
  pool: pg.Pool;
  providers: Providers;
  confirmationTtlMs?: number;
  /** Injectable for deterministic traces. */
  newId?: () => string;
}

export interface OperationView {
  operation_id: string;
  status: OperationStatus;
  customer_status: CustomerStatus;
  order_id: string;
  target_address_id: string;
  reason: string | null;
  created_at: string;
  updated_at: string;
  verified: { order_address_id: string; carrier_address_id: string } | null;
}

export type SubmitResult =
  | { kind: 'created'; operation: OperationView; confirmation: { token: string; expires_at: string } }
  | { kind: 'replayed'; operation: OperationView; confirmation?: { token: string; expires_at: string } };

const newToken = () => randomBytes(16).toString('base64url');

/**
 * A replay by the owner of a request still awaiting confirmation gets a fresh token, and
 * the previous one stops working. A client that lost the 202 can still confirm, and a
 * leaked earlier token is revoked. The expiry is not extended.
 */
async function reissueConfirmation(pool: pg.Pool, op: OperationRow) {
  if (op.status !== 'NEEDS_CONFIRMATION') return undefined;
  const token = newToken();
  const { rows } = await pool.query<{ expires_at: Date }>(
    `UPDATE ledger.confirmations SET token_sha256 = $2
     WHERE operation_id = $1 AND confirmed_at IS NULL AND expires_at > now() RETURNING expires_at`,
    [op.id, hashToken(token)],
  );
  const row = rows[0];
  return row ? { token, expires_at: row.expires_at.toISOString() } : undefined;
}

/** Request-time refusals: HTTP status and public code per reason. */
const REFUSALS: Record<string, { status: number; code: ErrorCode; message: string }> = {
  ORDER_NOT_FOUND: { status: 404, code: 'ORDER_NOT_FOUND', message: 'order not found' },
  ADDRESS_NOT_FOUND: { status: 422, code: 'ADDRESS_NOT_FOUND', message: 'address is not saved to your account' },
  ORDER_NOT_ELIGIBLE: { status: 422, code: 'ORDER_NOT_ELIGIBLE', message: 'this order can no longer change its delivery address' },
  ADDRESS_UNCHANGED: { status: 422, code: 'ADDRESS_UNCHANGED', message: 'the order already uses this address' },
};

const fingerprintOf = (input: Pick<AddressChangeRequest, 'order_id' | 'new_address_id'>) =>
  createHash('sha256').update(JSON.stringify([input.order_id, input.new_address_id])).digest('hex');

async function viewOf(db: pg.Pool | pg.PoolClient, op: OperationRow): Promise<OperationView> {
  let verified: OperationView['verified'] = null;
  if (op.status === 'COMPLETED') {
    const done = (await listEvents(db, op.id)).find((e) => e.to_status === 'COMPLETED');
    const v = (done?.detail as { verification?: { orderAddressId: string; carrierAddressId: string } } | null)?.verification;
    if (v) verified = { order_address_id: v.orderAddressId, carrier_address_id: v.carrierAddressId };
  }
  return {
    operation_id: op.id,
    status: op.status,
    customer_status: customerStatus(op.status),
    order_id: op.order_id,
    target_address_id: op.target_address_id,
    reason: op.public_reason,
    created_at: op.created_at.toISOString(),
    updated_at: op.updated_at.toISOString(),
    verified,
  };
}

function refusalFor(op: OperationRow): AppError | null {
  if (op.status !== 'REJECTED' || !op.public_reason) return null;
  const r = REFUSALS[op.public_reason];
  return r ? new AppError(r.status, r.code, r.message, undefined, op.id) : null;
}

/** Expires blocking confirmations for this order so a fresh request can proceed. */
async function expireStaleConfirmations(pool: pg.Pool, orderId: string): Promise<void> {
  await inTransaction(pool, async (client) => {
    const { rows } = await client.query<OperationRow>(
      `SELECT o.* FROM ledger.operations o JOIN ledger.confirmations c ON c.operation_id = o.id
       WHERE o.order_id = $1 AND o.status = 'NEEDS_CONFIRMATION' AND c.confirmed_at IS NULL AND c.expires_at <= now()
       FOR UPDATE OF o SKIP LOCKED`,
      [orderId],
    );
    for (const op of rows) await applyTransition(client, op, 'REJECTED', 'CONFIRMATION_EXPIRED');
  });
}

const pgConstraint = (err: unknown) => ((err as { code?: string }).code === '23505' ? (err as { constraint?: string }).constraint : undefined);

export async function submitAddressChange(deps: RequestDeps, identity: Identity, input: AddressChangeRequest): Promise<SubmitResult> {
  const { pool, providers } = deps;
  const fingerprint = fingerprintOf(input);

  const replay = async (): Promise<SubmitResult | null> => {
    const { rows } = await pool.query<OperationRow>('SELECT * FROM ledger.operations WHERE customer_id = $1 AND idempotency_key = $2', [identity.customerId, input.idempotency_key]);
    const existing = rows[0];
    if (!existing) return null;
    if (existing.request_fingerprint !== fingerprint) {
      throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', 'this idempotency key was already used for a different request');
    }
    const refused = refusalFor(existing);
    if (refused) throw refused;
    const confirmation = await reissueConfirmation(pool, existing);
    return { kind: 'replayed', operation: await viewOf(pool, existing), ...(confirmation ? { confirmation } : {}) };
  };
  const prior = await replay();
  if (prior) return prior;

  // Validate against the order system of record, as the session's customer (I1, I2).
  const read = await providers.order.get(identity.customerId, input.order_id);
  if (read.kind === 'unknown' || (read.kind === 'rejected' && read.status !== 404)) {
    throw new AppError(503, 'DEPENDENCY_UNAVAILABLE', 'order system unavailable; nothing was recorded, retry with the same key');
  }
  const order: Order | null = read.kind === 'ok' ? read.body.order : null;
  const address = order
    ? (await pool.query('SELECT 1 FROM identity.saved_addresses WHERE id = $1 AND customer_id = $2', [input.new_address_id, identity.customerId])).rowCount
    : 0;
  const refusal = !order
    ? 'ORDER_NOT_FOUND'
    : !address
      ? 'ADDRESS_NOT_FOUND'
      : !isEligibleForAddressChange(order.status)
        ? 'ORDER_NOT_ELIGIBLE'
        : order.address_id === input.new_address_id
          ? 'ADDRESS_UNCHANGED'
          : null;

  const id = (deps.newId ?? newOperationId)();
  const create = () =>
    inTransaction(pool, async (client) => {
      // A refused request is recorded as REJECTED directly, so it never touches the
      // in-flight index (and cannot reveal another customer's in-flight operation).
      const initial: OperationStatus = refusal ? 'REJECTED' : 'RECEIVED';
      const { rows } = await client.query<OperationRow>(
        `INSERT INTO ledger.operations
           (id, customer_id, idempotency_key, request_fingerprint, order_id, target_address_id, status,
            carrier_ref, original_address_id, validated_order_version, public_reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
        [id, identity.customerId, input.idempotency_key, fingerprint, input.order_id, input.new_address_id, initial,
         order?.carrier_ref ?? null, order?.address_id ?? null, order?.version ?? null, refusal],
      );
      let op = rows[0] as OperationRow;
      await appendEvent(client, op.id, { step: 'TRANSITION', from_status: null, to_status: 'RECEIVED', reason_code: 'REQUEST_RECEIVED' });
      if (refusal) {
        assertTransition({ from: 'RECEIVED', to: 'REJECTED', reasonCode: refusal, targetAddressId: op.target_address_id, visited: ['RECEIVED'] });
        await appendEvent(client, op.id, { step: 'TRANSITION', from_status: 'RECEIVED', to_status: 'REJECTED', reason_code: refusal });
        return { op, token: null };
      }
      const token = newToken();
      const ttl = deps.confirmationTtlMs ?? 15 * 60_000;
      await client.query(
        `INSERT INTO ledger.confirmations (operation_id, token_sha256, expires_at) VALUES ($1, $2, now() + make_interval(secs => $3::float8 / 1000))`,
        [op.id, hashToken(token), ttl],
      );
      op = await applyTransition(client, op, 'NEEDS_CONFIRMATION', 'AWAITING_CUSTOMER_CONFIRMATION');
      return { op, token };
    });

  let created: { op: OperationRow; token: string | null };
  try {
    created = await create();
  } catch (err) {
    const constraint = pgConstraint(err);
    if (constraint === 'operations_customer_idempotency_key_uq') {
      const raced = await replay();
      if (raced) return raced;
      throw new AppError(409, 'OPERATION_IN_PROGRESS', 'a request with this idempotency key is being processed; retry with the same key');
    }
    if (constraint !== 'operations_one_unresolved_per_order_uq') throw err;
    await expireStaleConfirmations(pool, input.order_id);
    try {
      created = await create();
    } catch (again) {
      if (pgConstraint(again) === 'operations_one_unresolved_per_order_uq') {
        throw new AppError(409, 'OPERATION_IN_PROGRESS', 'another address change for this order is still in progress');
      }
      throw again;
    }
  }

  const refused = refusalFor(created.op);
  if (refused) throw refused;
  const { rows } = await pool.query<{ expires_at: Date }>('SELECT expires_at FROM ledger.confirmations WHERE operation_id = $1', [created.op.id]);
  return {
    kind: 'created',
    operation: await viewOf(pool, created.op),
    confirmation: { token: created.token as string, expires_at: (rows[0] as { expires_at: Date }).expires_at.toISOString() },
  };
}

async function ownedOperation(db: pg.Pool | pg.PoolClient, identity: Identity, operationId: string, lock = false): Promise<OperationRow> {
  const { rows } = await db.query<OperationRow>(
    `SELECT * FROM ledger.operations WHERE id = $1 AND customer_id = $2${lock ? ' FOR UPDATE' : ''}`,
    [operationId, identity.customerId],
  );
  const op = rows[0];
  if (!op) throw new AppError(404, 'OPERATION_NOT_FOUND', 'operation not found');
  return op;
}

const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export async function confirmOperation(deps: RequestDeps, identity: Identity, operationId: string, token: string): Promise<OperationView> {
  const outcome = await inTransaction(deps.pool, async (client) => {
    const op = await ownedOperation(client, identity, operationId, true);
    const { rows } = await client.query<{ token_sha256: string; expires_at: Date; confirmed_at: Date | null; expired: boolean }>(
      'SELECT token_sha256, expires_at, confirmed_at, expires_at <= now() AS expired FROM ledger.confirmations WHERE operation_id = $1',
      [op.id],
    );
    const challenge = rows[0];
    if (!challenge) throw new AppError(409, 'OPERATION_NOT_AWAITING_CONFIRMATION', 'this operation does not need confirmation');
    const matches = sameHash(challenge.token_sha256, hashToken(token));
    if (op.status !== 'NEEDS_CONFIRMATION') {
      // Repeating a successful confirmation is harmless and returns the current state.
      if (challenge.confirmed_at && matches) return { op, expired: false };
      if (op.public_reason === 'CONFIRMATION_EXPIRED') return { op, expired: true };
      throw new AppError(409, 'OPERATION_NOT_AWAITING_CONFIRMATION', 'this operation is no longer awaiting confirmation');
    }
    if (challenge.expired) return { op: await applyTransition(client, op, 'REJECTED', 'CONFIRMATION_EXPIRED'), expired: true };
    if (!matches) throw new AppError(403, 'CONFIRMATION_INVALID', 'confirmation token is not valid for this operation');
    await client.query('UPDATE ledger.confirmations SET confirmed_at = now() WHERE operation_id = $1', [op.id]);
    return { op: await applyTransition(client, op, 'QUEUED', 'CONFIRMED_BY_CUSTOMER'), expired: false };
  });
  // The expiry is committed before the error is raised, so the order is freed either way.
  if (outcome.expired) throw new AppError(410, 'CONFIRMATION_EXPIRED', 'confirmation expired; submit a new request', undefined, outcome.op.id);
  return viewOf(deps.pool, outcome.op);
}

export async function getOperation(deps: RequestDeps, identity: Identity, operationId: string): Promise<OperationView> {
  return viewOf(deps.pool, await ownedOperation(deps.pool, identity, operationId));
}

export async function getOperationEvents(deps: RequestDeps, identity: Identity, operationId: string) {
  const op = await ownedOperation(deps.pool, identity, operationId);
  return (await listEvents(deps.pool, op.id)).map((e) => ({
    sequence: e.sequence,
    step: e.step,
    from_status: e.from_status,
    to_status: e.to_status,
    reason_code: e.reason_code,
    result: e.result,
    error_code: e.error_code,
    provider_reference: e.provider_reference,
    detail: e.detail,
    at: e.created_at.toISOString(),
  }));
}
