// Minimal entities from docs/PROTOTYPE_SPEC.md §8. Field names mirror the DB columns.

export const ORDER_STATUSES = ['PLACED', 'PACKING', 'SHIPPED', 'DELIVERED'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const SHIPMENT_STATUSES = ['AWAITING_PICKUP', 'IN_TRANSIT', 'DELIVERED'] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

export interface Customer {
  id: string;
}

export interface SavedAddress {
  id: string;
  customer_id: string;
  normalized_address: string;
}

export interface Order {
  id: string;
  customer_id: string;
  status: OrderStatus;
  address_id: string;
  version: number;
  carrier_ref: string;
}

export interface CarrierShipment {
  carrier_ref: string;
  address_id: string;
  status: ShipmentStatus;
  version: number;
}
