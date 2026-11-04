// Independent verifier (ADR-0009 §7): fresh reads of both systems of record. It never
// trusts a write acknowledgement; only what each provider reports now.
import type { DualSystemVerification } from '../domain/operation-state.ts';
import type { Providers } from './adapters.ts';

export type Verification =
  | { kind: 'matches'; evidence: DualSystemVerification }
  | { kind: 'differs'; evidence: DualSystemVerification }
  | { kind: 'unavailable'; detail: string };

export async function readBothSystems(providers: Providers, op: { customer_id: string; order_id: string; carrier_ref: string | null }, expectedAddressId: string): Promise<Verification> {
  if (!op.carrier_ref) return { kind: 'unavailable', detail: 'operation has no carrier reference' };
  const [order, shipment] = await Promise.all([providers.order.get(op.customer_id, op.order_id), providers.carrier.get(op.carrier_ref)]);
  if (order.kind !== 'ok') return { kind: 'unavailable', detail: `order read ${order.kind}` };
  if (shipment.kind !== 'ok') return { kind: 'unavailable', detail: `carrier read ${shipment.kind}` };
  const evidence = { orderAddressId: order.body.order.address_id, carrierAddressId: shipment.body.shipment.address_id };
  return evidence.orderAddressId === expectedAddressId && evidence.carrierAddressId === expectedAddressId
    ? { kind: 'matches', evidence }
    : { kind: 'differs', evidence };
}
