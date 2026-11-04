import type pg from 'pg';
import type { Fixture } from '../../fixtures/generate.ts';
import { dropAll, migrate } from './migrate.ts';
import { seed } from './seed.ts';

/** Drop every project schema, migrate from zero and seed. Callers must guard the target. */
export async function resetDatabase(pool: pg.Pool, fixture: Fixture): Promise<string[]> {
  await dropAll(pool);
  const { applied } = await migrate(pool);
  await seed(pool, fixture);
  return applied;
}
