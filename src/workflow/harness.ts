// Assembles variant A in-process: API, both providers, worker factory. Used by the trace
// script and the integration tests so both exercise the identical stack.
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.ts';
import { createPool } from '../db/pool.ts';
import { ProviderClient } from '../providers/client.ts';
import { startProviderPair } from '../providers/harness.ts';
import { createProviders, type Providers } from './adapters.ts';
import type { RequestDeps } from './requests.ts';
import { Worker, type WorkerOptions } from './worker.ts';

export interface VariantAOptions {
  clientTimeoutMs?: number;
  requests?: Pick<RequestDeps, 'confirmationTtlMs' | 'newId'>;
}

export async function startVariantA(databaseUrl: string, { clientTimeoutMs = 150, requests = {} }: VariantAOptions = {}) {
  const pool = createPool(databaseUrl);
  const pair = await startProviderPair(databaseUrl);
  const providers: Providers = createProviders({ orderUrl: pair.orderUrl, carrierUrl: pair.carrierUrl, timeoutMs: clientTimeoutMs });
  const app: FastifyInstance = buildApp({ pool, providers, requests });
  await app.ready();
  return {
    pool,
    pair,
    providers,
    app,
    admin: { order: new ProviderClient({ baseUrl: pair.orderUrl }), carrier: new ProviderClient({ baseUrl: pair.carrierUrl }) },
    worker: (o: Partial<WorkerOptions> = {}) => new Worker({ pool, providers, backoffMs: () => 0, ...o }),
    async close() {
      await app.close();
      await pair.close();
      await pool.end();
    },
  };
}
export type VariantA = Awaited<ReturnType<typeof startVariantA>>;
