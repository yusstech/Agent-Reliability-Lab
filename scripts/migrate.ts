import { loadConfig } from '../src/config.ts';
import { migrate } from '../src/db/migrate.ts';
import { createPool } from '../src/db/pool.ts';

const pool = createPool(loadConfig().databaseUrl);
try {
  const { applied, skipped } = await migrate(pool);
  console.log(`migrations applied: ${applied.join(', ') || '(none)'}; already applied: ${skipped.join(', ') || '(none)'}`);
} finally {
  await pool.end();
}
