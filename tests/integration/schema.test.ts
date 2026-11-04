import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { generateFixture } from '../../fixtures/generate.ts';
import { migrate } from '../../src/db/migrate.ts';
import { seed } from '../../src/db/seed.ts';
import { OPERATION_STATUSES, TERMINAL_STATUSES } from '../../src/domain/operation-state.ts';
import { createTestPool } from '../helpers/db.ts';

const pool: pg.Pool = createTestPool();
afterAll(() => pool.end());
beforeEach(() => seed(pool, generateFixture()));

const FP = 'a'.repeat(64);
let opSeq = 0;
async function insertOp(over: Partial<Record<string, unknown>> = {}) {
  const row = {
    id: `op_${++opSeq}`,
    customer_id: 'cus_001',
    idempotency_key: `key_${opSeq}_abcdef`,
    request_fingerprint: FP,
    order_id: 'ord_1001',
    target_address_id: 'addr_002',
    status: 'RECEIVED',
    ...over,
  };
  await pool.query(
    `INSERT INTO ledger.operations (id, customer_id, idempotency_key, request_fingerprint, order_id, target_address_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [row.id, row.customer_id, row.idempotency_key, row.request_fingerprint, row.order_id, row.target_address_id, row.status],
  );
  return row;
}

async function pgErrorCode(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
  } catch (err) {
    return (err as { code?: string }).code;
  }
  return undefined;
}

describe('schema and constraints', () => {
  it('DB-01 migrations are idempotent and checksum-tracked', async () => {
    const again = await migrate(pool);
    expect(again.applied).toEqual([]);
    expect(again.skipped).toContain('0001_foundation');
  });

  it('DB-02 (customer_id, idempotency_key) is unique', async () => {
    await insertOp({ idempotency_key: 'dup_key_001' });
    expect(await pgErrorCode(() => insertOp({ idempotency_key: 'dup_key_001', order_id: 'ord_1002' }))).toBe('23505');
    // The same key from a different customer is a different request.
    await insertOp({ idempotency_key: 'dup_key_001', customer_id: 'cus_002', order_id: 'ord_1003' });
  });

  it('DB-03 at most one unresolved operation per order', async () => {
    await insertOp({ status: 'QUEUED' });
    expect(await pgErrorCode(() => insertOp({ status: 'RECEIVED' }))).toBe('23505');
    expect(await pgErrorCode(() => insertOp({ status: 'PENDING_RECONCILIATION' }))).toBe('23505');
  });

  it('DB-04 terminal operations do not block a new request on the same order', async () => {
    await insertOp({ status: 'COMPLETED' });
    await insertOp({ status: 'REJECTED' });
    await insertOp({ status: 'NEEDS_MANUAL_REVIEW' });
    await insertOp({ status: 'RECEIVED' });
  });

  it('DB-05 the partial index agrees with TERMINAL_STATUSES for every status', async () => {
    for (const status of OPERATION_STATUSES) {
      await seed(pool, generateFixture());
      await insertOp({ status });
      const blocked = (await pgErrorCode(() => insertOp({ status: 'RECEIVED' }))) === '23505';
      expect(blocked, status).toBe(!TERMINAL_STATUSES.has(status));
    }
  });

  it('DB-06 enum-like columns reject unknown values', async () => {
    expect(await pgErrorCode(() => insertOp({ status: 'DONE' }))).toBe('23514');
    expect(await pgErrorCode(() => pool.query(`UPDATE order_svc.orders SET status = 'LOST' WHERE id = 'ord_1001'`))).toBe('23514');
    expect(await pgErrorCode(() => pool.query(`UPDATE carrier_svc.shipments SET version = 0 WHERE carrier_ref = 'shp_0001'`))).toBe('23514');
  });

  it('DB-07 operation events are append-only', async () => {
    const op = await insertOp();
    await pool.query(
      `INSERT INTO ledger.operation_events (operation_id, sequence, step, from_status, to_status, reason_code)
       VALUES ($1, 1, 'CREATE', NULL, 'RECEIVED', 'REQUEST_ACCEPTED')`,
      [op.id],
    );
    expect(await pgErrorCode(() => pool.query(`UPDATE ledger.operation_events SET reason_code = 'EDITED' WHERE operation_id = $1`, [op.id]))).toBe('23001');
    expect(await pgErrorCode(() => pool.query(`DELETE FROM ledger.operation_events WHERE operation_id = $1`, [op.id]))).toBe('23001');
    expect(
      await pgErrorCode(() =>
        pool.query(`INSERT INTO ledger.operation_events (operation_id, sequence, step, reason_code) VALUES ($1, 1, 'DUP', 'DUP')`, [op.id]),
      ),
    ).toBe('23505');
  });

  it('DB-08 an event with from_status must name to_status', async () => {
    const op = await insertOp();
    expect(
      await pgErrorCode(() =>
        pool.query(
          `INSERT INTO ledger.operation_events (operation_id, sequence, step, from_status, reason_code) VALUES ($1, 1, 'X', 'RECEIVED', 'X')`,
          [op.id],
        ),
      ),
    ).toBe('23514');
  });

  it('DB-08b event statuses are limited to the operation status list', async () => {
    const op = await insertOp();
    let seq = 0;
    for (const status of OPERATION_STATUSES) {
      await pool.query(
        `INSERT INTO ledger.operation_events (operation_id, sequence, step, from_status, to_status, reason_code) VALUES ($1, $2, 'X', $3, $3, 'X')`,
        [op.id, ++seq, status],
      );
    }
    for (const [col, bad] of [['to_status', 'COMPLETE'], ['from_status', 'done']] as const) {
      expect(
        await pgErrorCode(() =>
          pool.query(
            `INSERT INTO ledger.operation_events (operation_id, sequence, step, from_status, to_status, reason_code) VALUES ($1, $2, 'X', $3, $4, 'X')`,
            [op.id, ++seq, col === 'from_status' ? bad : null, col === 'to_status' ? bad : 'RECEIVED'],
          ),
        ),
        col,
      ).toBe('23514');
    }
  });

  it('DB-09 provider schemas carry no foreign keys into other schemas', async () => {
    const { rows } = await pool.query(`
      SELECT tc.table_schema, tc.table_name, ccu.table_schema AS ref_schema
      FROM information_schema.table_constraints tc
      JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema <> ccu.table_schema`);
    expect(rows).toEqual([]);
  });
});
