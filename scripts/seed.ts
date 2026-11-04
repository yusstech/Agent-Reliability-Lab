import { fixtureDigest, fixtureSeedFromEnv, generateFixture } from '../fixtures/generate.ts';
import { assertLocalDatabase, assertNotProduction, loadConfig } from '../src/config.ts';
import { createPool } from '../src/db/pool.ts';
import { seed } from '../src/db/seed.ts';

const config = loadConfig();
assertNotProduction(config.nodeEnv, 'seed');
assertLocalDatabase(config.databaseUrl, 'seed');
const fixture = generateFixture(fixtureSeedFromEnv());
const pool = createPool(config.databaseUrl);
try {
  await seed(pool, fixture);
  console.log(
    `seeded ${fixture.version} seed=${fixture.seed} digest=${fixtureDigest(fixture)} ` +
      `customers=${fixture.customers.length} addresses=${fixture.saved_addresses.length} ` +
      `orders=${fixture.orders.length} shipments=${fixture.shipments.length}`,
  );
} finally {
  await pool.end();
}
