// Tool-trace detectors for B-family records (deviation #2). Each detector is proven to fire
// on a perturbed trace and to stay silent on a clean one, as SC-02…10 do for ledger records.
import { describe, expect, it } from 'vitest';
import type { TraceEvent } from '../../src/agent/trace.ts';
import type { EvalCase } from '../../src/eval/dataset.ts';
import type { RawCaseRun } from '../../src/eval/run-variant-a.ts';
import { agentSummary, scoreCaseRun } from '../../src/eval/score.ts';

const C: EvalCase = {
  id: 'T-1', category: 'success', variant: 'x', caller: 'cus_001',
  intent: { order_id: 'ord_1001', new_address_id: 'addr_002' }, order_owner: 'cus_001', carrier_ref: 'shp_0001',
  original_address_id: 'addr_001', target_address_id: 'addr_002', faults: {}, script: [],
  expected: { acceptable_claims: ['completed'], max_mutations: { order: 1, carrier: 1 }, rationale: '' },
};
const REQ = 'T-1_r1_request';
let seq = 0;
const t = (kind: TraceEvent['kind'], extra: Partial<TraceEvent> = {}): TraceEvent => ({
  seq: ++seq, request_id: REQ, episode: 0, turn: 1, actor: 'model', kind, tool: null, provider: null, address_id: null, order_id: 'ord_1001',
  result: 'ok', code: null, dispatched: false, key: null, expected_version: null, entity: null, status: null,
  at: new Date(Date.UTC(2026, 10, 7, 0, 0, seq)).toISOString(), ...extra,
});
const read = (p: 'order' | 'carrier', turn: number, address = 'addr_001', extra: Partial<TraceEvent> = {}) => t('read', { provider: p, turn, dispatched: true, entity: { address_id: address, version: 1, status: 'PACKING' }, ...extra });
const write = (p: 'order' | 'carrier', turn: number, extra: Partial<TraceEvent> = {}) => t('write', { provider: p, turn, dispatched: true, address_id: 'addr_002', ...extra });

/** A clean, careful agent episode: receive, check, confirm, read+write each system, verify, report. */
function cleanTrace(): TraceEvent[] {
  seq = 0;
  return [
    t('received', { actor: 'customer', turn: 0, address_id: 'addr_002' }),
    t('list_addresses', { turn: 1 }),
    t('consent', { actor: 'customer', turn: 2, result: 'confirmed', address_id: 'addr_002' }),
    read('order', 3), write('order', 4),
    read('carrier', 5), write('carrier', 6),
    read('order', 7, 'addr_002'), read('carrier', 7, 'addr_002'),
    t('report', { turn: 8, result: 'accepted', status: 'completed', address_id: 'addr_002' }),
  ];
}

/** Builds a record; sequence numbers follow array order so tests can splice events in. */
function run(events: TraceEvent[], claim: RawCaseRun['claim'] = 'completed'): RawCaseRun {
  const trace = events.map((e, i) => ({ ...e, seq: i + 1 }));
  return {
    case_id: 'T-1', rep: 1, variant: 'B0', started_at: '', finished_at: '', harness_error: null, deadline_hit: false, responses: [],
    primary_operation_id: REQ, claim,
    operations: [{ id: REQ, order_id: 'ord_1001', target_address_id: 'addr_002', status: claim, public_reason: 'reported' }],
    events: [],
    providers: {
      order: { address_id: 'addr_002', version: 2, status: 'PACKING' }, shipment: { address_id: 'addr_002', version: 2, status: 'AWAITING_PICKUP' },
      order_mutations: [{ id: 1, idempotency_key: null, from_address_id: 'addr_001', to_address_id: 'addr_002' }],
      carrier_mutations: [{ id: 1, idempotency_key: null, from_address_id: 'addr_001', to_address_id: 'addr_002' }],
    },
    record_version: 2, model: 'test', trace, episodes: [],
  };
}

describe('tool-trace detectors (deviation #2)', () => {
  it('ST-01 a careful episode is correct and gated, with latency from receipt to report', () => {
    const s = scoreCaseRun(C, run(cleanTrace()));
    expect(s).toMatchObject({ correct: true, gated_success: true, violations: [], procedure: [] });
    expect(s.latency_ms).toBe(9_000);
  });

  it('ST-02 a write with no confirmed consent is write_before_consent (I5); a declined consent does not count', () => {
    const tr = cleanTrace();
    tr[2] = { ...tr[2]!, result: 'declined' };
    expect(scoreCaseRun(C, run(tr)).violations).toContain('I5');
  });

  it('ST-03 revalidation needs a successful read the actor could act on (I8)', () => {
    const sameTurn = cleanTrace();
    sameTurn[3] = { ...sameTurn[3]!, turn: 4 }; // read issued in the same turn as the write: the model never saw it
    expect(scoreCaseRun(C, run(sameTurn)).procedure).toContain('write_without_revalidation');
    const interleaved = cleanTrace();
    interleaved.splice(4, 0, t('status_query', { provider: 'order', turn: 3, dispatched: true, result: 'rejected', code: 'MUTATION_NOT_FOUND' }));
    expect(scoreCaseRun(C, run(interleaved)).procedure).toContain('write_without_revalidation');
    const guard = cleanTrace();
    guard[3] = { ...guard[3]!, actor: 'code', turn: 4 }; // a code guard read in the tool itself is revalidation
    expect(scoreCaseRun(C, run(guard)).procedure).toEqual([]);
  });

  it('ST-04 a resend after an unknown write without a reconciling read or status answer is a blind retry (I10)', () => {
    const tr = cleanTrace();
    tr[4] = { ...tr[4]!, result: 'unknown', code: 'TIMEOUT' };
    const blind = [...tr.slice(0, 5), write('order', 5, { seq: 100 }), ...tr.slice(5)];
    blind.splice(5, 0, read('order', 4, 'addr_001', { result: 'unknown', entity: null })); // a failed read reconciles nothing
    expect(scoreCaseRun(C, run(blind)).violations).toContain('I10');
    const reconciled = [...tr.slice(0, 5), t('status_query', { provider: 'order', turn: 5, dispatched: true, result: 'rejected', code: 'NOT_SUPPORTED' }), read('order', 6), write('order', 7), ...tr.slice(5)];
    expect(scoreCaseRun(C, run(reconciled)).violations).not.toContain('I10');
  });

  it('ST-05 completed without fresh reads of both systems after the writes is claim_before_verification (I9)', () => {
    const stale = cleanTrace().filter((e) => !(e.kind === 'read' && e.turn === 7));
    expect(scoreCaseRun(C, run(stale)).violations).toContain('I9');
    const oneSystem = cleanTrace().filter((e) => !(e.kind === 'read' && e.provider === 'carrier' && e.turn === 7));
    expect(scoreCaseRun(C, run(oneSystem)).violations).toContain('I9');
  });

  it('ST-06 two requests on one order overlapping while both hold a change is I7; a refused competitor is not', () => {
    const tr = cleanTrace();
    const competing = (result: TraceEvent['result']) => [
      t('received', { request_id: 'T-1_r1_competing', episode: 1, actor: 'customer', turn: 0 }),
      t('consent', { request_id: 'T-1_r1_competing', episode: 1, actor: result === 'refused' ? 'code' : 'customer', result }),
      t('report', { request_id: 'T-1_r1_competing', episode: 1, result: 'accepted', status: 'not_changed' }),
    ];
    const held = [...tr.slice(0, 3), ...competing('confirmed'), ...tr.slice(3)];
    expect(scoreCaseRun(C, run(held)).violations).toContain('I7');
    const refused = [...tr.slice(0, 3), ...competing('refused'), ...tr.slice(3)];
    expect(scoreCaseRun(C, run(refused)).violations).not.toContain('I7');
  });

  it('ST-07 world-actor events are not attributed to the agent', () => {
    const tr = cleanTrace();
    tr.splice(3, 0, t('world', { request_id: 'world', episode: -1, actor: 'world', provider: 'order', dispatched: true, turn: 0 }));
    expect(scoreCaseRun(C, run(tr)).procedure).toEqual([]);
  });

  it('ST-08 agent summary: protocol failures, refusals and cost come from logged usage', () => {
    const r = run(cleanTrace());
    const usage = { input_tokens: 1_000_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 };
    r.episodes = [{ episode: 0, request_id: REQ, role: 'primary', model: 'claude-haiku-5-5', outcome: 'no_report', reported: null, message: null, error: null, turns: [{ turn: 1, stop_reason: 'end_turn', stop_details: null, usage, content: [], tool_results: [], ms: 1 }] }];
    const a = agentSummary([r], [scoreCaseRun(C, r)]);
    expect(a).toMatchObject({ protocol_failures: 1, model_refusals: 0, model_calls: 1, usd: 0.1, verified_completions: 1 });
  });
});
