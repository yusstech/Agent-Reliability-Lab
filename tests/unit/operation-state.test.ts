import { describe, expect, it } from 'vitest';
import {
  OPERATION_STATUSES,
  TERMINAL_STATUSES,
  TransitionError,
  allowedNextStatuses,
  assertTransition,
  type OperationStatus,
  type TransitionInput,
} from '../../src/domain/operation-state.ts';

const TARGET = 'addr_072';
const verified = { orderAddressId: TARGET, carrierAddressId: TARGET };

function codeOf(input: TransitionInput): string | null {
  try {
    assertTransition(input);
    return null;
  } catch (err) {
    if (err instanceof TransitionError) return err.code;
    throw err;
  }
}

const t = (from: OperationStatus, to: OperationStatus, extra: Partial<TransitionInput> = {}): TransitionInput => ({
  from,
  to,
  reasonCode: 'TEST_REASON',
  targetAddressId: TARGET,
  visited: [],
  ...extra,
});

describe('operation state model', () => {
  it('ST-01 happy path is permitted end to end', () => {
    const path: OperationStatus[] = ['RECEIVED', 'NEEDS_CONFIRMATION', 'QUEUED', 'UPDATING_ORDER', 'UPDATING_CARRIER', 'VERIFYING', 'COMPLETED'];
    for (let i = 0; i < path.length - 1; i++) {
      expect(codeOf(t(path[i]!, path[i + 1]!, { verification: verified }))).toBeNull();
    }
  });

  it('ST-02 terminal statuses permit no transitions', () => {
    for (const from of TERMINAL_STATUSES) {
      expect(allowedNextStatuses(from)).toEqual([]);
      for (const to of OPERATION_STATUSES) expect(codeOf(t(from, to, { verification: verified }))).toBe('TERMINAL_STATE');
    }
  });

  it('ST-03 every non-terminal status can always escalate or reject (no dead ends)', () => {
    for (const from of OPERATION_STATUSES) {
      if (TERMINAL_STATUSES.has(from)) continue;
      const next = allowedNextStatuses(from);
      expect(next.length).toBeGreaterThan(0);
      expect(next.some((s) => s === 'NEEDS_MANUAL_REVIEW' || s === 'REJECTED')).toBe(true);
    }
  });

  it('ST-04 COMPLETED is reachable only from VERIFYING', () => {
    for (const from of OPERATION_STATUSES) {
      const permitted = codeOf(t(from, 'COMPLETED', { verification: verified })) === null;
      expect(permitted, from).toBe(from === 'VERIFYING');
    }
  });

  it('ST-05 COMPLETED without dual-system verification is refused', () => {
    expect(codeOf(t('VERIFYING', 'COMPLETED'))).toBe('UNVERIFIED_COMPLETION');
    expect(codeOf(t('VERIFYING', 'COMPLETED', { verification: { orderAddressId: TARGET, carrierAddressId: 'addr_001' } }))).toBe('UNVERIFIED_COMPLETION');
    expect(codeOf(t('VERIFYING', 'COMPLETED', { verification: { orderAddressId: 'addr_001', carrierAddressId: TARGET } }))).toBe('UNVERIFIED_COMPLETION');
  });

  it('ST-06 no exit to REJECTED once the carrier write may have been dispatched', () => {
    for (const from of ['UPDATING_CARRIER', 'VERIFYING', 'PENDING_RECONCILIATION', 'COMPENSATING'] as const) {
      expect(codeOf(t(from, 'REJECTED'))).not.toBeNull();
    }
  });

  it('ST-06b ...including indirectly, via reconciliation and an order retry', () => {
    // UPDATING_CARRIER timed out -> reconcile -> retry order -> order provider rejects.
    const visited: OperationStatus[] = ['RECEIVED', 'NEEDS_CONFIRMATION', 'QUEUED', 'UPDATING_ORDER', 'UPDATING_CARRIER', 'PENDING_RECONCILIATION'];
    expect(codeOf(t('PENDING_RECONCILIATION', 'UPDATING_ORDER', { visited }))).toBeNull();
    expect(codeOf(t('UPDATING_ORDER', 'REJECTED', { visited: [...visited, 'UPDATING_ORDER'] }))).toBe('SIDE_EFFECT_POSSIBLE');
    // The same retry, when the carrier was never reached, may still be definitively rejected.
    const orderOnly: OperationStatus[] = ['RECEIVED', 'NEEDS_CONFIRMATION', 'QUEUED', 'UPDATING_ORDER', 'PENDING_RECONCILIATION', 'UPDATING_ORDER'];
    expect(codeOf(t('UPDATING_ORDER', 'REJECTED', { visited: orderOnly }))).toBeNull();
  });

  it('ST-06c exhaustive: no path that enters UPDATING_CARRIER can end in REJECTED', () => {
    // Breadth-first search over (status, carrierVisited) through assertTransition itself.
    const seen = new Set<string>();
    const queue: { status: OperationStatus; visited: OperationStatus[] }[] = [{ status: 'RECEIVED', visited: ['RECEIVED'] }];
    while (queue.length) {
      const { status, visited } = queue.shift()!;
      const key = `${status}|${visited.includes('UPDATING_CARRIER')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      for (const to of allowedNextStatuses(status)) {
        if (codeOf(t(status, to, { visited, verification: verified })) !== null) continue;
        if (to === 'REJECTED') expect(visited, `${status} -> REJECTED`).not.toContain('UPDATING_CARRIER');
        queue.push({ status: to, visited: [...visited, to] });
      }
    }
    expect(seen.has('REJECTED|true')).toBe(false);
  });

  it('ST-06d after the carrier step, REJECTED needs fresh evidence that both systems are restored', () => {
    const visited: OperationStatus[] = ['RECEIVED', 'NEEDS_CONFIRMATION', 'QUEUED', 'UPDATING_ORDER', 'UPDATING_CARRIER', 'COMPENSATING'];
    const original = 'addr_001';
    const base = { visited, originalAddressId: original };
    expect(codeOf(t('COMPENSATING', 'REJECTED', base))).toBe('SIDE_EFFECT_POSSIBLE');
    expect(codeOf(t('COMPENSATING', 'REJECTED', { ...base, compensation: { orderAddressId: original, carrierAddressId: TARGET } }))).toBe('SIDE_EFFECT_POSSIBLE');
    expect(codeOf(t('COMPENSATING', 'REJECTED', { ...base, compensation: { orderAddressId: TARGET, carrierAddressId: original } }))).toBe('SIDE_EFFECT_POSSIBLE');
    expect(codeOf(t('COMPENSATING', 'REJECTED', { ...base, compensation: { orderAddressId: original, carrierAddressId: original } }))).toBeNull();
    // Evidence without a declared original proves nothing.
    expect(codeOf(t('COMPENSATING', 'REJECTED', { visited, compensation: { orderAddressId: original, carrierAddressId: original } }))).toBe('SIDE_EFFECT_POSSIBLE');
  });

  it('ST-07 confirmation cannot be skipped', () => {
    expect(codeOf(t('RECEIVED', 'QUEUED'))).toBe('INVALID_TRANSITION');
    expect(codeOf(t('NEEDS_CONFIRMATION', 'UPDATING_ORDER'))).toBe('INVALID_TRANSITION');
    expect(codeOf(t('RECEIVED', 'UPDATING_ORDER'))).toBe('INVALID_TRANSITION');
  });

  it('ST-08 unknown outcomes can be reconciled, not silently completed', () => {
    expect(codeOf(t('UPDATING_ORDER', 'PENDING_RECONCILIATION'))).toBeNull();
    expect(codeOf(t('UPDATING_CARRIER', 'PENDING_RECONCILIATION'))).toBeNull();
    expect(codeOf(t('PENDING_RECONCILIATION', 'COMPLETED', { verification: verified }))).toBe('INVALID_TRANSITION');
    expect(codeOf(t('PENDING_RECONCILIATION', 'VERIFYING'))).toBeNull();
  });

  it('ST-09 self-transitions are not allowed', () => {
    for (const s of OPERATION_STATUSES) expect(codeOf(t(s, s))).not.toBeNull();
  });

  it('ST-10 reason codes must be UPPER_SNAKE_CASE', () => {
    expect(codeOf(t('RECEIVED', 'NEEDS_CONFIRMATION', { reasonCode: '' }))).toBe('INVALID_REASON_CODE');
    expect(codeOf(t('RECEIVED', 'NEEDS_CONFIRMATION', { reasonCode: 'looks fine' }))).toBe('INVALID_REASON_CODE');
  });
});
