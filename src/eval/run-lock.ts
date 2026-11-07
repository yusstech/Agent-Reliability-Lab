// One evaluation run per database (Plan §8.8 isolation). Every case-run reseeds the whole
// fixture, so two runs sharing a database silently corrupt each other's truth reads.
// Observed 2026-11-07: two concurrent B0 runs on arl_dev each wiped the other's writes.
// A session-level advisory lock, held on a dedicated connection for the whole run, makes
// a second run fail at start instead.
import type pg from 'pg';

const LOCK_KEY = 'arl-eval-run';

export class RunLockHeldError extends Error {
  constructor() {
    super('another evaluation run holds this database (advisory lock "arl-eval-run"); wait for it to finish');
    this.name = 'RunLockHeldError';
  }
}

/** Acquires the run lock or throws. Release by calling the returned function (or by exiting). */
export async function acquireRunLock(pool: pg.Pool): Promise<() => Promise<void>> {
  const client = await pool.connect();
  const { rows } = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [LOCK_KEY]);
  if (!rows[0]?.ok) {
    client.release();
    throw new RunLockHeldError();
  }
  return async () => {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK_KEY]).catch(() => {});
    client.release();
  };
}
