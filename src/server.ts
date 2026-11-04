import { buildApp } from './app.ts';
import { assertNotProduction, loadConfig } from './config.ts';
import { createPool } from './db/pool.ts';
import { createProviders } from './workflow/adapters.ts';

const config = loadConfig();
assertNotProduction(config.nodeEnv, 'the API (mock authentication)');

const pool = createPool(config.databaseUrl);
const app = buildApp({
  pool,
  providers: createProviders({
    orderUrl: process.env.ORDER_SERVICE_URL ?? 'http://127.0.0.1:3101',
    carrierUrl: process.env.CARRIER_SERVICE_URL ?? 'http://127.0.0.1:3102',
  }),
  logger: { level: 'info', redact: ['req.headers.authorization'] },
});

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  try {
    await app.close();
    await pool.end();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'shutdown failed');
    process.exit(1);
  }
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: '127.0.0.1', port: config.port });
