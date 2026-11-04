// Starts both mock providers in-process on ephemeral ports, each with its own
// role-scoped pool. Used by the trace script and the integration tests.
import type { AddressInfo } from 'node:net';
import { buildCarrierService } from './carrier-service.ts';
import { buildOrderService } from './order-service.ts';
import { createProviderPool } from './pools.ts';

export async function startProviderPair(databaseUrl: string) {
  const orderPool = createProviderPool(databaseUrl, 'arl_order_svc');
  const carrierPool = createProviderPool(databaseUrl, 'arl_carrier_svc');
  const order = buildOrderService({ pool: orderPool, devRoutes: true });
  const carrier = buildCarrierService({ pool: carrierPool, devRoutes: true });
  await order.app.listen({ host: '127.0.0.1', port: 0 });
  await carrier.app.listen({ host: '127.0.0.1', port: 0 });
  const url = (addr: AddressInfo | string | null) => `http://127.0.0.1:${(addr as AddressInfo).port}`;
  return {
    orderUrl: url(order.app.server.address()),
    carrierUrl: url(carrier.app.server.address()),
    orderPool,
    carrierPool,
    order,
    carrier,
    async close() {
      await order.app.close();
      await carrier.app.close();
      await orderPool.end();
      await carrierPool.end();
    },
  };
}
