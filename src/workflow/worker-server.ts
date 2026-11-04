// Runs the variant A worker as its own process: `node src/workflow/worker-server.ts`.
import { assertNotProduction, loadConfig } from '../config.ts';
import { createPool } from '../db/pool.ts';
import { createProviders } from './adapters.ts';
import { Worker } from './worker.ts';

const config = loadConfig();
assertNotProduction(config.nodeEnv, 'the worker');
const pool = createPool(config.databaseUrl);
const worker = new Worker({
  pool,
  providers: createProviders({
    orderUrl: config.orderServiceUrl,
    carrierUrl: config.carrierServiceUrl,
  }),
});

let running = true;
const stop = () => {
  running = false;
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

console.log('worker started');
while (running) {
  try {
    if (!(await worker.runOnce())) await new Promise((r) => setTimeout(r, 200));
  } catch (err) {
    // A failed step keeps its lease until expiry; another attempt picks it up then.
    console.error('step failed', (err as Error).message);
    await new Promise((r) => setTimeout(r, 500));
  }
}
await pool.end();
console.log('worker stopped');
