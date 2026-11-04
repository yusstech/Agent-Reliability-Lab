// Drop, migrate and reseed the configured database. Local development only.
import { fixtureSeedFromEnv, generateFixture } from '../fixtures/generate.ts';
import { assertLocalDatabase, assertNotProduction, loadConfig } from '../src/config.ts';
import { createPool } from '../src/db/pool.ts';
import { resetDatabase } from '../src/db/reset.ts';

const config = loadConfig();
assertNotProduction(config.nodeEnv, 'db:reset');
assertLocalDatabase(config.databaseUrl, 'db:reset');
const pool = createPool(config.databaseUrl);
try {
  const applied = await resetDatabase(pool, generateFixture(fixtureSeedFromEnv()));
  console.log(`reset complete; migrations applied: ${applied.join(', ')}`);
} finally {
  await pool.end();
}
