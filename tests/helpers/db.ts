import pg from 'pg';
import { generateFixture } from '../../fixtures/generate.ts';
import { assertLocalDatabase } from '../../src/config.ts';
import { createPool } from '../../src/db/pool.ts';
import { resetDatabase } from '../../src/db/reset.ts';

/** Refuses anything but a database whose name ends in `_test`: the suite drops schemas. */
export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is required (copy .env.example to .env)');
  const dbName = new URL(url).pathname.replace(/^\//, '');
  if (!dbName.endsWith('_test')) throw new Error(`refusing to run destructive tests against "${dbName}"`);
  assertLocalDatabase(url, 'test suite');
  return url;
}

export const createTestPool = () => createPool(testDatabaseUrl());

/** Creates the `_test` database on the same server if it does not exist yet. */
async function ensureTestDatabase(url: string): Promise<void> {
  const target = new URL(url);
  const dbName = target.pathname.replace(/^\//, '');
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    // Name is already restricted to *_test by testDatabaseUrl(); quote it as an identifier anyway.
    if (!rowCount) await client.query(`CREATE DATABASE "${dbName.replaceAll('"', '""')}"`);
  } finally {
    await client.end();
  }
}

export async function resetTestDatabase(): Promise<void> {
  await ensureTestDatabase(testDatabaseUrl());
  const pool = createTestPool();
  try {
    await resetDatabase(pool, generateFixture());
  } finally {
    await pool.end();
  }
}
