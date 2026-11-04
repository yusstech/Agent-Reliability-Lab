import type { Order } from '../domain/types.ts';
import { buildProvider, type ProviderOptions } from './provider.ts';

/** Mock order system of record. Customer-scoped; no eligibility rule (I4 is app policy). */
export function buildOrderService(options: ProviderOptions) {
  return buildProvider<Order>(
    {
      kind: 'order',
      name: 'order-service',
      prefix: '/orders',
      entityName: 'order',
      idPattern: /^ord_[a-z0-9]{1,32}$/,
      entity: {
        table: 'order_svc.orders',
        keyColumn: 'id',
        mutationTable: 'order_svc.address_mutations',
        mutationKeyColumn: 'order_id',
        columns: 'id, customer_id, status, address_id, version, carrier_ref',
      },
      actor: {
        header: 'x-acting-customer-id',
        pattern: /^cus_[a-z0-9]{1,32}$/,
        // Not-owned orders are indistinguishable from missing ones (404).
        canSee: (row, actor) => row.customer_id === actor,
      },
      concurrentStatusChange: async (pool, id) => {
        await pool.query(`UPDATE order_svc.orders SET status = 'SHIPPED', version = version + 1 WHERE id = $1`, [id]);
      },
    },
    options,
  );
}
