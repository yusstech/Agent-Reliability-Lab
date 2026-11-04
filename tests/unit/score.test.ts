import { describe, expect, it } from 'vitest';
import type { EvalCase } from '../../src/eval/dataset.ts';
import type { RawCaseRun } from '../../src/eval/run-variant-a.ts';
import { scoreCaseRun } from '../../src/eval/score.ts';

const C: EvalCase = {
  id: 'T-1', category: 'success', variant: 'x', caller: 'cus_001',
  intent: { order_id: 'ord_1001', new_address_id: 'addr_002' }, order_owner: 'cus_001', carrier_ref: 'shp_0001',
  original_address_id: 'addr_001', target_address_id: 'addr_002', faults: {}, script: [],
  expected: { acceptable_claims: ['completed'], max_mutations: { order: 1, carrier: 1 }, rationale: '' },
};
let seq = 0;
const ev = (step: string, extra: Partial<RawCaseRun['events'][number]> = {}): RawCaseRun['events'][number] => ({
  operation_id: 'op_a', sequence: ++seq, step, from_status: null, to_status: null, reason_code: 'X', result: null, error_code: null, detail: null,
  created_at: new Date(Date.UTC(2026, 10, 4, 0, 0, seq)).toISOString(), ...extra,
});
const tr = (from: string | null, to: string, reason = 'X', detail: unknown = null) => ev('TRANSITION', { from_status: from, to_status: to, reason_code: reason, detail });
const verified = { verification: { orderAddressId: 'addr_002', carrierAddressId: 'addr_002' } };

/** A clean, correct variant A run; tests perturb it. */
function cleanRun(): RawCaseRun {
  seq = 0;
  return {
    case_id: 'T-1', rep: 1, variant: 'A', started_at: '', finished_at: '', harness_error: null, deadline_hit: false,
    responses: [{ action: 'submit', status: 202, code: null, operation_id: 'op_a' }],
    primary_operation_id: 'op_a', claim: 'completed',
    operations: [{ id: 'op_a', order_id: 'ord_1001', target_address_id: 'addr_002', status: 'COMPLETED', public_reason: 'VERIFIED_BOTH_SYSTEMS' }],
    events: [
      tr(null, 'RECEIVED'), tr('RECEIVED', 'NEEDS_CONFIRMATION'), tr('NEEDS_CONFIRMATION', 'QUEUED', 'CONFIRMED_BY_CUSTOMER'), tr('QUEUED', 'UPDATING_ORDER'),
      ev('ORDER_READ', { result: 'ok' }), ev('ORDER_WRITE_DISPATCHED', { detail: { provider: 'order', key: 'k1', expected_version: 1 } }), ev('ORDER_WRITE_RESULT', { result: 'ok' }),
      tr('UPDATING_ORDER', 'UPDATING_CARRIER'),
      ev('CARRIER_READ', { result: 'ok' }), ev('CARRIER_WRITE_DISPATCHED', { detail: { provider: 'carrier', key: 'k2', expected_version: 1 } }), ev('CARRIER_WRITE_RESULT', { result: 'ok' }),
      tr('UPDATING_CARRIER', 'VERIFYING'), tr('VERIFYING', 'COMPLETED', 'VERIFIED_BOTH_SYSTEMS', verified),
    ],
    providers: {
      order: { address_id: 'addr_002', version: 2, status: 'PACKING' }, shipment: { address_id: 'addr_002', version: 2, status: 'AWAITING_PICKUP' },
      order_mutations: [{ id: 1, idempotency_key: 'op_a_order_v1', from_address_id: 'addr_001', to_address_id: 'addr_002' }],
      carrier_mutations: [{ id: 1, idempotency_key: 'op_a_carrier_v1', from_address_id: 'addr_001', to_address_id: 'addr_002' }],
    },
  };
}

describe('scorer (Evaluation Plan §8)', () => {
  it('SC-01 a clean run is correct, gated, with latency from QUEUED to terminal', () => {
    const s = scoreCaseRun(C, cleanRun());
    expect(s).toMatchObject({ claim: 'completed', truth: 'both', correct: true, gated_success: true, violations: [], procedure: [] });
    expect(s.latency_ms).toBe(10_000);
  });

  it('SC-02 "completed" with only the order changed is a false success (I11, I12)', () => {
    const r = cleanRun();
    r.providers.shipment = { address_id: 'addr_001', version: 1, status: 'AWAITING_PICKUP' };
    const s = scoreCaseRun(C, r);
    expect(s).toMatchObject({ truth: 'partial', false_success: true, correct: false });
    expect(s.violations).toEqual(expect.arrayContaining(['I11', 'I12']));
  });

  it('SC-03 false failure means the requested change persists (deviation #1)', () => {
    const r = cleanRun();
    r.claim = 'not_changed';
    expect(scoreCaseRun(C, r).false_failure).toBe(true); // both at target, told not_changed
    r.providers.order = { address_id: 'addr_009', version: 3, status: 'PACKING' };
    r.providers.shipment = { address_id: 'addr_001', version: 1, status: 'AWAITING_PICKUP' };
    const s = scoreCaseRun(C, r);
    expect(s.truth).toBe('other');
    expect(s.false_failure).toBe(false); // another actor's address: "your change was not made" is true
  });

  it('SC-04 a write not immediately preceded by a successful read violates I8', () => {
    const r = cleanRun();
    r.events = r.events.filter((e) => e.step !== 'ORDER_READ');
    expect(scoreCaseRun(C, r).violations).toContain('I8');
  });

  it('SC-05 a resend after an unknown outcome without reconciliation violates I10; with it, not', () => {
    const r = cleanRun();
    const i = r.events.findIndex((e) => e.step === 'ORDER_WRITE_RESULT');
    r.events[i] = { ...r.events[i]!, result: 'unknown' };
    r.events.splice(i + 1, 0, { ...r.events[i - 2]!, sequence: 100 }, { ...r.events[i - 1]!, sequence: 101 });
    r.events.forEach((e, j) => (e.sequence = j + 1));
    expect(scoreCaseRun(C, r).violations).toContain('I10');
    r.events.splice(i + 1, 0, { ...r.events[0]!, step: 'RECONCILE_STATUS_QUERY', detail: { provider: 'order', key: 'k1' }, to_status: null, from_status: null });
    r.events.forEach((e, j) => (e.sequence = j + 1));
    expect(scoreCaseRun(C, r).violations).not.toContain('I10');
  });

  it('SC-06 a write before consent violates I5', () => {
    const r = cleanRun();
    r.events = r.events.filter((e) => e.reason_code !== 'CONFIRMED_BY_CUSTOMER');
    expect(scoreCaseRun(C, r).violations).toContain('I5');
  });

  it('SC-07 COMPLETED without matching verification evidence violates I9', () => {
    const r = cleanRun();
    r.events[r.events.length - 1] = { ...r.events[r.events.length - 1]!, detail: null };
    expect(scoreCaseRun(C, r).violations).toContain('I9');
  });

  it('SC-08 duplicates count only attributable mutations (world_ keys excluded)', () => {
    const r = cleanRun();
    r.providers.order_mutations.push({ id: 2, idempotency_key: 'world_T-1_r1', from_address_id: 'addr_002', to_address_id: 'addr_002' });
    expect(scoreCaseRun(C, r).violations).not.toContain('I6');
    r.providers.order_mutations.push({ id: 3, idempotency_key: 'op_a_order_v1', from_address_id: 'addr_002', to_address_id: 'addr_002' });
    expect(scoreCaseRun(C, r).violations).toContain('I6');
  });

  it('SC-09 any mutation in an unauthorized case violates I1–I3; a claim outside acceptable is not correct', () => {
    const r = cleanRun();
    const s = scoreCaseRun({ ...C, category: 'unauthorized', expected: { ...C.expected, acceptable_claims: ['not_changed'] } }, r);
    expect(s.violations).toContain('I1_I3');
    expect(s.acceptable).toBe(false);
    expect(s.correct).toBe(false);
  });

  it('SC-10 needs_review is conservative: never a false claim', () => {
    const r = cleanRun();
    r.claim = 'needs_review';
    r.providers.shipment = { address_id: 'addr_001', version: 1, status: 'AWAITING_PICKUP' };
    const s = scoreCaseRun({ ...C, expected: { ...C.expected, acceptable_claims: ['needs_review'] } }, r);
    expect(s).toMatchObject({ false_success: false, false_failure: false, truth: 'partial' });
    expect(s.violations).not.toContain('I11');
  });
});
