// Operation state model, spec §6. Pure functions: no I/O, no clock.
//
// Design rule: once a carrier write may have been dispatched, the operation can only
// finish as REJECTED through COMPENSATING, with fresh evidence that both systems are back
// at the original address (ADR-0009 §6). The edge table alone cannot enforce this,
// because PENDING_RECONCILIATION -> UPDATING_ORDER -> REJECTED is a legal path, so
// assertTransition also checks the statuses the operation has visited.
// UPDATING_ORDER -> REJECTED is for a *definitive* order rejection (nothing written).
// Timeouts are unknowns, never rejections.

export const OPERATION_STATUSES = [
  'RECEIVED',
  'NEEDS_CONFIRMATION',
  'QUEUED',
  'UPDATING_ORDER',
  'UPDATING_CARRIER',
  'VERIFYING',
  'COMPENSATING',
  'COMPLETED',
  'REJECTED',
  'PENDING_RECONCILIATION',
  'NEEDS_MANUAL_REVIEW',
] as const;
export type OperationStatus = (typeof OPERATION_STATUSES)[number];

// Terminal to automated execution. Mirrored by the partial unique index in
// migrations/0001_foundation.sql (tests/integration/schema.test.ts checks they agree).
export const TERMINAL_STATUSES: ReadonlySet<OperationStatus> = new Set([
  'COMPLETED',
  'REJECTED',
  'NEEDS_MANUAL_REVIEW',
]);

const ALLOWED_TRANSITIONS: Readonly<Record<OperationStatus, readonly OperationStatus[]>> = {
  RECEIVED: ['NEEDS_CONFIRMATION', 'REJECTED'],
  NEEDS_CONFIRMATION: ['QUEUED', 'REJECTED'],
  QUEUED: ['UPDATING_ORDER', 'REJECTED'],
  UPDATING_ORDER: ['UPDATING_CARRIER', 'REJECTED', 'PENDING_RECONCILIATION', 'NEEDS_MANUAL_REVIEW'],
  UPDATING_CARRIER: ['VERIFYING', 'COMPENSATING', 'PENDING_RECONCILIATION', 'NEEDS_MANUAL_REVIEW'],
  VERIFYING: ['COMPLETED', 'PENDING_RECONCILIATION', 'NEEDS_MANUAL_REVIEW'],
  COMPENSATING: ['REJECTED', 'NEEDS_MANUAL_REVIEW'],
  PENDING_RECONCILIATION: ['UPDATING_ORDER', 'UPDATING_CARRIER', 'VERIFYING', 'NEEDS_MANUAL_REVIEW'],
  COMPLETED: [],
  REJECTED: [],
  NEEDS_MANUAL_REVIEW: [],
};

/** Evidence from fresh, authoritative reads of both systems of record. */
export interface DualSystemVerification {
  orderAddressId: string;
  carrierAddressId: string;
}

export interface TransitionInput {
  from: OperationStatus;
  to: OperationStatus;
  reasonCode: string;
  targetAddressId: string;
  /** Every status this operation has held so far, from the ledger's event history. */
  visited: readonly OperationStatus[];
  /** Required when `to` is COMPLETED. */
  verification?: DualSystemVerification;
  /** The address the order had before this operation; required with `compensation`. */
  originalAddressId?: string;
  /** Required for REJECTED once the carrier step was entered: both systems back at the original. */
  compensation?: DualSystemVerification;
}

export type TransitionErrorCode =
  | 'TERMINAL_STATE'
  | 'INVALID_TRANSITION'
  | 'INVALID_REASON_CODE'
  | 'UNVERIFIED_COMPLETION'
  | 'SIDE_EFFECT_POSSIBLE';

export class TransitionError extends Error {
  readonly code: TransitionErrorCode;
  constructor(code: TransitionErrorCode, message: string) {
    super(message);
    this.name = 'TransitionError';
    this.code = code;
  }
}

const REASON_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

export function isTerminal(status: OperationStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function allowedNextStatuses(from: OperationStatus): readonly OperationStatus[] {
  return ALLOWED_TRANSITIONS[from];
}

/** Throws TransitionError unless the transition is permitted with the given evidence. */
export function assertTransition(input: TransitionInput): void {
  const { from, to, reasonCode, targetAddressId, visited, verification, originalAddressId, compensation } = input;

  if (isTerminal(from)) {
    throw new TransitionError('TERMINAL_STATE', `${from} is terminal; start a separately authorized recovery instead`);
  }
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new TransitionError('INVALID_TRANSITION', `${from} -> ${to} is not an allowed transition`);
  }
  if (!REASON_CODE.test(reasonCode)) {
    throw new TransitionError('INVALID_REASON_CODE', 'reasonCode must be UPPER_SNAKE_CASE');
  }
  // COMPENSATING implies the carrier step was entered, even if a caller's history is incomplete.
  const carrierStepEntered = from === 'UPDATING_CARRIER' || from === 'COMPENSATING' || visited.includes('UPDATING_CARRIER');
  if (to === 'REJECTED' && carrierStepEntered) {
    const restored =
      originalAddressId !== undefined &&
      compensation?.orderAddressId === originalAddressId &&
      compensation.carrierAddressId === originalAddressId;
    if (!restored) {
      throw new TransitionError(
        'SIDE_EFFECT_POSSIBLE',
        'a carrier write may have been dispatched; REJECTED needs fresh evidence that both systems are back at the original address',
      );
    }
  }
  if (to === 'COMPLETED') {
    // A tool's "success" is not enough: both systems must show the target address.
    if (
      !verification ||
      verification.orderAddressId !== targetAddressId ||
      verification.carrierAddressId !== targetAddressId
    ) {
      throw new TransitionError(
        'UNVERIFIED_COMPLETION',
        'COMPLETED requires fresh reads showing the target address in both order and carrier systems',
      );
    }
  }
}
