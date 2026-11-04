// Provider adapters for the orchestrator. Identity for the order provider always comes
// from the operation's server-recorded customer, never from request input (I1/I2).
import type { CarrierShipment, Order } from '../domain/types.ts';
import { type Outcome, ProviderClient } from '../providers/client.ts';

export interface Mutation {
  id: number;
  entity_id: string;
  idempotency_key: string | null;
  from_address_id: string;
  to_address_id: string;
  from_version: number;
  to_version: number;
}

export interface WriteBody {
  address_id: string;
  idempotency_key: string;
  expected_version: number;
}

export interface Providers {
  order: {
    get(customerId: string, orderId: string): Promise<Outcome<{ order: Order }>>;
    list(customerId: string): Promise<Outcome<{ orders: Order[] }>>;
    change(customerId: string, orderId: string, body: WriteBody): Promise<Outcome<{ mutation: Mutation; order: Order }>>;
    status(customerId: string, orderId: string, key: string): Promise<Outcome<{ applied: true; mutation: Mutation }>>;
  };
  carrier: {
    get(ref: string): Promise<Outcome<{ shipment: CarrierShipment }>>;
    change(ref: string, body: WriteBody): Promise<Outcome<{ mutation: Mutation; shipment: CarrierShipment }>>;
    status(ref: string, key: string): Promise<Outcome<{ applied: true; mutation: Mutation }>>;
  };
}

export interface ProviderEndpoints {
  orderUrl: string;
  carrierUrl: string;
  timeoutMs?: number;
}

export function createProviders({ orderUrl, carrierUrl, timeoutMs = 2000 }: ProviderEndpoints): Providers {
  const orders = new ProviderClient({ baseUrl: orderUrl, timeoutMs });
  const carrier = new ProviderClient({ baseUrl: carrierUrl, timeoutMs });
  const as = (customerId: string) => orders.withHeaders({ 'x-acting-customer-id': customerId });
  const enc = encodeURIComponent;
  return {
    order: {
      get: (c, id) => as(c).request('GET', `/orders/${enc(id)}`),
      list: (c) => as(c).request('GET', '/orders'),
      change: (c, id, body) => as(c).request('POST', `/orders/${enc(id)}/address-changes`, body),
      status: (c, id, key) => as(c).request('GET', `/orders/${enc(id)}/address-changes/${enc(key)}`),
    },
    carrier: {
      get: (ref) => carrier.request('GET', `/shipments/${enc(ref)}`),
      change: (ref, body) => carrier.request('POST', `/shipments/${enc(ref)}/address-changes`, body),
      status: (ref, key) => carrier.request('GET', `/shipments/${enc(ref)}/address-changes/${enc(key)}`),
    },
  };
}
