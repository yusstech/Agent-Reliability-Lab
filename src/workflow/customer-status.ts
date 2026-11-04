import type { OperationStatus } from '../domain/operation-state.ts';

/** What the customer is told (ADR-0009 §11). The I12 claim channel for variant A. */
export type CustomerStatus = 'completed' | 'not_changed' | 'pending' | 'needs_review';

export function customerStatus(status: OperationStatus): CustomerStatus {
  switch (status) {
    case 'COMPLETED':
      return 'completed';
    case 'REJECTED':
      return 'not_changed';
    case 'NEEDS_MANUAL_REVIEW':
      return 'needs_review';
    default:
      return 'pending';
  }
}
