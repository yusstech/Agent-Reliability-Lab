// Starts one mock provider as its own process: `node src/providers/server.ts order|carrier`.
import { assertNotProduction, loadConfig } from '../config.ts';
import { buildCarrierService } from './carrier-service.ts';
import { buildOrderService } from './order-service.ts';
import { createProviderPool } from './pools.ts';

const which = process.argv[2];
if (which !== 'order' && which !== 'carrier') {
  console.error('usage: node src/providers/server.ts order|carrier');
  process.exit(2);
}
const config = loadConfig();
assertNotProduction(config.nodeEnv, `the ${which} mock provider`);
const portVar = which === 'order' ? 'ORDER_SERVICE_PORT' : 'CARRIER_SERVICE_PORT';
const port = Number(process.env[portVar] ?? (which === 'order' ? 3101 : 3102));

const pool = createProviderPool(config.databaseUrl, which === 'order' ? 'arl_order_svc' : 'arl_carrier_svc');
const { app } = (which === 'order' ? buildOrderService : buildCarrierService)({ pool, devRoutes: true });

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  try {
    await app.close();
    await pool.end();
    process.exit(0);
  } catch (err) {
    console.error('shutdown failed', err);
    process.exit(1);
  }
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

await app.listen({ host: '127.0.0.1', port });
console.log(`${which} provider listening on http://127.0.0.1:${port}`);
