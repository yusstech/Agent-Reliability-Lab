import type pg from 'pg';
import type { Fixture } from '../../fixtures/generate.ts';
import { hashToken } from '../security/token-hash.ts';

// Every fixture table; truncated together in one statement so FKs are satisfied.
const TABLES = [
  'ledger.confirmations',
  'ledger.operation_events',
  'ledger.operations',
  'carrier_svc.address_mutations',
  'order_svc.address_mutations',
  'carrier_svc.shipments',
  'order_svc.orders',
  'identity.mock_sessions',
  'identity.saved_addresses',
  'identity.customers',
];

async function insertMany(client: pg.PoolClient, table: string, columns: string[], rows: Record<string, unknown>[]): Promise<void> {
  if (rows.length === 0) return;
  const values: unknown[] = [];
  const tuples = rows.map((row, i) => {
    for (const col of columns) values.push(row[col]);
    return `(${columns.map((_, j) => `$${i * columns.length + j + 1}`).join(', ')})`;
  });
  await client.query(`INSERT INTO ${table} (${columns.join(', ')}) VALUES ${tuples.join(', ')}`, values);
}

/** Replaces all fixture data atomically. Callers must guard against non-local databases. */
export async function seed(pool: pg.Pool, fixture: Fixture): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // TRUNCATE is used so the append-only row trigger on operation_events still forbids
    // DELETE/UPDATE in normal operation while allowing a full fixture reset.
    // RESTART IDENTITY makes provider mutation ids deterministic after every reset.
    await client.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY`);
    await insertMany(client, 'identity.customers', ['id'], fixture.customers as unknown as Record<string, unknown>[]);
    await insertMany(client, 'identity.saved_addresses', ['id', 'customer_id', 'normalized_address'], fixture.saved_addresses as unknown as Record<string, unknown>[]);
    await insertMany(
      client,
      'identity.mock_sessions',
      ['token_sha256', 'customer_id'],
      fixture.sessions.map((s) => ({ token_sha256: hashToken(s.token), customer_id: s.customer_id })),
    );
    await insertMany(client, 'order_svc.orders', ['id', 'customer_id', 'status', 'address_id', 'version', 'carrier_ref'], fixture.orders as unknown as Record<string, unknown>[]);
    await insertMany(client, 'carrier_svc.shipments', ['carrier_ref', 'address_id', 'status', 'version'], fixture.shipments as unknown as Record<string, unknown>[]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Canonical, ordered dump of seeded tables; used to prove seeding is deterministic. */
export async function dumpFixtureTables(pool: pg.Pool) {
  const q = async (sql: string) => (await pool.query(sql)).rows;
  return {
    customers: await q('SELECT id FROM identity.customers ORDER BY id'),
    saved_addresses: await q('SELECT id, customer_id, normalized_address FROM identity.saved_addresses ORDER BY id'),
    mock_sessions: await q('SELECT token_sha256, customer_id FROM identity.mock_sessions ORDER BY customer_id'),
    orders: await q('SELECT id, customer_id, status, address_id, version, carrier_ref FROM order_svc.orders ORDER BY id'),
    shipments: await q('SELECT carrier_ref, address_id, status, version FROM carrier_svc.shipments ORDER BY carrier_ref'),
  };
}
