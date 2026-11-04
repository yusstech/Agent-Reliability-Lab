import type { CarrierShipment } from '../domain/types.ts';
import { ProviderError } from './http.ts';
import { buildProvider, type ProviderOptions } from './provider.ts';

/** Mock carrier system of record. Merchant-trusted; refuses changes once dispatched. */
export function buildCarrierService(options: ProviderOptions) {
  return buildProvider<CarrierShipment>(
    {
      kind: 'carrier',
      name: 'carrier-service',
      prefix: '/shipments',
      entityName: 'shipment',
      idPattern: /^shp_[a-z0-9]{1,32}$/,
      entity: {
        table: 'carrier_svc.shipments',
        keyColumn: 'carrier_ref',
        mutationTable: 'carrier_svc.address_mutations',
        mutationKeyColumn: 'carrier_ref',
        columns: 'carrier_ref, address_id, status, version',
        guard: (row) =>
          row.status === 'AWAITING_PICKUP'
            ? null
            : new ProviderError(422, 'SHIPMENT_DISPATCHED', `shipment is ${row.status}; address can no longer change`),
      },
      concurrentStatusChange: async (pool, ref) => {
        await pool.query(`UPDATE carrier_svc.shipments SET status = 'IN_TRANSIT', version = version + 1 WHERE carrier_ref = $1`, [ref]);
      },
    },
    options,
  );
}
