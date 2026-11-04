// Minimal forward-only migration runner: ordered .sql files, each applied in its own
// transaction, with a checksum so an edited, already-applied migration is detected.
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';

export const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '../../migrations');
const LOCK_KEY = 4210001; // arbitrary, constant advisory-lock key for migrations

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export async function migrate(pool: pg.Pool, dir: string = MIGRATIONS_DIR): Promise<MigrationResult> {
  const files = (await readdir(dir)).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
  const client = await pool.connect();
  const result: MigrationResult = { applied: [], skipped: [] };
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS public.schema_migrations (
      version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const { rows } = await client.query<{ version: string; checksum: string }>('SELECT version, checksum FROM public.schema_migrations');
    const applied = new Map(rows.map((r) => [r.version, r.checksum]));

    for (const file of files) {
      const sql = await readFile(path.join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const version = file.replace(/\.sql$/, '');
      const existing = applied.get(version);
      if (existing !== undefined) {
        if (existing !== checksum) throw new Error(`migration ${version} was modified after being applied; add a new migration instead`);
        result.skipped.push(version);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO public.schema_migrations (version, checksum) VALUES ($1, $2)', [version, checksum]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
      result.applied.push(version);
    }
    return result;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    client.release();
  }
}

/** Drops every project schema. Local/test databases only; callers must guard. */
export async function dropAll(pool: pg.Pool): Promise<void> {
  await pool.query(`DROP SCHEMA IF EXISTS identity, order_svc, carrier_svc, ledger CASCADE;
                    DROP TABLE IF EXISTS public.schema_migrations;`);
}
