// The one write path both providers share: a versioned, optionally idempotent address
// change committed together with its mutation-log row (ADR-0008 §2–3).
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type pg from 'pg';
import { ProviderError } from './http.ts';

export const AddressChangeBodySchema = z.strictObject({
  address_id: z.string().regex(/^addr_[a-z0-9]{1,32}$/),
  idempotency_key: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/).optional(),
  expected_version: z.number().int().min(1).optional(),
});
export type AddressChangeBody = z.infer<typeof AddressChangeBodySchema>;

export interface EntityTable<Row> {
  /** Fully qualified constant table names; never derived from input. */
  table: string;
  keyColumn: string;
  mutationTable: string;
  mutationKeyColumn: string;
  columns: string;
  /** Business guard evaluated under the row lock; return an error to refuse the write. */
  guard?: (row: Row) => ProviderError | null;
}

export interface MutationRecord {
  id: number;
  entity_id: string;
  idempotency_key: string | null;
  from_address_id: string;
  to_address_id: string;
  from_version: number;
  to_version: number;
}

export interface AddressChangeResult<Row> {
  replayed: boolean;
  mutation: MutationRecord;
  /** Row as read under the lock, before this request (equal to `entity` on replay). */
  before: Row;
  entity: Row;
}

export function fingerprint(entityId: string, body: AddressChangeBody): string {
  const canonical = JSON.stringify([entityId, body.address_id, body.expected_version ?? null]);
  return createHash('sha256').update(canonical).digest('hex');
}

const MUTATION_COLUMNS = (keyCol: string) =>
  `id::int AS id, ${keyCol} AS entity_id, idempotency_key, from_address_id, to_address_id, from_version, to_version`;

/** Applies one address change in a single transaction. Throws ProviderError on refusal. */
export async function applyAddressChange<Row extends { address_id: string; version: number }>(
  pool: pg.Pool,
  spec: EntityTable<Row>,
  entityId: string,
  body: AddressChangeBody,
  honourIdempotencyKeys: boolean,
  isVisible: (row: Row) => boolean = () => true,
): Promise<AddressChangeResult<Row>> {
  const fp = fingerprint(entityId, body);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (honourIdempotencyKeys && body.idempotency_key) {
      // Serialise all use of one key, across entities, for the rest of the transaction.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [body.idempotency_key]);
    }
    const { rows } = await client.query<Row>(`SELECT ${spec.columns} FROM ${spec.table} WHERE ${spec.keyColumn} = $1 FOR UPDATE`, [entityId]);
    const row = rows[0];
    if (!row || !isVisible(row)) throw new ProviderError(404, 'NOT_FOUND', 'entity not found');

    if (honourIdempotencyKeys && body.idempotency_key) {
      const prior = await client.query<MutationRecord & { request_fingerprint: string }>(
        `SELECT ${MUTATION_COLUMNS(spec.mutationKeyColumn)}, request_fingerprint FROM ${spec.mutationTable} WHERE idempotency_key = $1 ORDER BY id LIMIT 1`,
        [body.idempotency_key],
      );
      const hit = prior.rows[0];
      if (hit) {
        if (hit.request_fingerprint !== fp) {
          throw new ProviderError(409, 'IDEMPOTENCY_KEY_REUSED', 'idempotency key was used with a different request');
        }
        await client.query('COMMIT');
        const { request_fingerprint: _fp, ...mutation } = hit;
        return { replayed: true, mutation, before: row, entity: row };
      }
    }

    const refusal = spec.guard?.(row);
    if (refusal) throw refusal;
    if (body.expected_version !== undefined && body.expected_version !== row.version) {
      throw new ProviderError(409, 'VERSION_CONFLICT', `expected version ${body.expected_version}, found ${row.version}`);
    }

    const updated = await client.query<Row>(
      `UPDATE ${spec.table} SET address_id = $2, version = version + 1 WHERE ${spec.keyColumn} = $1 RETURNING ${spec.columns}`,
      [entityId, body.address_id],
    );
    const entity = updated.rows[0] as Row;
    const inserted = await client.query<MutationRecord>(
      `INSERT INTO ${spec.mutationTable} (${spec.mutationKeyColumn}, idempotency_key, request_fingerprint, from_address_id, to_address_id, from_version, to_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${MUTATION_COLUMNS(spec.mutationKeyColumn)}`,
      [entityId, body.idempotency_key ?? null, fp, row.address_id, body.address_id, row.version, entity.version],
    );
    await client.query('COMMIT');
    return { replayed: false, mutation: inserted.rows[0] as MutationRecord, before: row, entity };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Authoritative lookup of an applied mutation by idempotency key (honoured mode only). */
export async function findMutationByKey(pool: pg.Pool, spec: EntityTable<unknown>, entityId: string, key: string) {
  const { rows } = await pool.query<MutationRecord>(
    `SELECT ${MUTATION_COLUMNS(spec.mutationKeyColumn)} FROM ${spec.mutationTable} WHERE ${spec.mutationKeyColumn} = $1 AND idempotency_key = $2 ORDER BY id LIMIT 1`,
    [entityId, key],
  );
  return rows[0];
}
