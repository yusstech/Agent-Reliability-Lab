import type { OrderStatus } from './types.ts';

// Spec §3: only PLACED or PACKING orders may have their delivery address changed.
const ELIGIBLE: ReadonlySet<OrderStatus> = new Set(['PLACED', 'PACKING']);

export function isEligibleForAddressChange(status: OrderStatus): boolean {
  return ELIGIBLE.has(status);
}
