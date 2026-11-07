// Phase 05 harness: rung enforcement in tool code, the tool-use loop, the paid-call gate, and
// end-to-end runs of the NAIVE control and of C. Scripted clients stand in for the model
// here to test mechanics only; they are never written to results/ (roadmap Phase 05).
import type Anthropic from '@anthropic-ai/sdk';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generateFixture } from '../../fixtures/generate.ts';
import { LOOP, type ModelClient, runEpisode } from '../../src/agent/loop.ts';
import { BudgetMeter, createPaidClient } from '../../src/agent/model-client.ts';
import { createNaiveClient } from '../../src/agent/naive.ts';
import { RUNGS, type RungId } from '../../src/agent/policy.ts';
import { SharedState, ToolLayer, type Request } from '../../src/agent/tools.ts';
import { TraceRecorder } from '../../src/agent/trace.ts';
import { seed } from '../../src/db/seed.ts';
import { buildDataset } from '../../src/eval/dataset.ts';
import { runCaseOnAgent, systemBlocks } from '../../src/eval/run-agent.ts';
import { runCaseOnVariantC } from '../../src/eval/run-variant-c.ts';
import { scoreCaseRun } from '../../src/eval/score.ts';
import { ProviderClient } from '../../src/providers/client.ts';
import { startVariantA, type VariantA } from '../../src/workflow/harness.ts';
import { testDatabaseUrl } from '../helpers/db.ts';

const fixture = generateFixture();
const dataset = buildDataset(fixture, 20261104);
const byId = (id: string) => dataset.cases.find((c) => c.id === id)!;
let a: VariantA;
beforeAll(async () => {
  a = await startVariantA(testDatabaseUrl(), { clientTimeoutMs: 500 });
});
afterAll(async () => {
  await seed(a.pool, fixture);
  await a.close();
});
beforeEach(async () => {
  await seed(a.pool, fixture);
  for (const p of ['order', 'carrier'] as const) await a.admin[p].request('DELETE', '/_dev/scenario');
});

// cus_003 owns ord_1009 (PLACED/PACKING, at addr_005) and ord_1008; addr_006 is theirs, addr_001 is not.
const MINE: Request = { id: 'TEST_r1_request', order_id: 'ord_1009', new_address_id: 'addr_006' };

function layer(rung: RungId, request: Request = MINE, shared = new SharedState(), trace = new TraceRecorder(), customerId = 'cus_003') {
  const tl = new ToolLayer({
    rung: RUNGS[rung], customerId, request, episode: 0, trace, shared, pool: a.pool,
    clients: {
      order: new ProviderClient({ baseUrl: a.pair.orderUrl, timeoutMs: 500, headers: { 'x-acting-customer-id': customerId } }),
      carrier: new ProviderClient({ baseUrl: a.pair.carrierUrl, timeoutMs: 500 }),
    },
    customerConfirms: (o, ad) => o === request.order_id && ad === request.new_address_id,
    fireHooks: async () => {},
  });
  return { tl, trace, shared, call: async (name: string, input: unknown) => JSON.parse((await tl.call(name, input)).content) };
}
const W = (address = 'addr_006', extra = {}) => ({ order_id: 'ord_1009', address_id: address, idempotency_key: null, expected_version: null, ...extra });
const counts = async () => (await a.pool.query('SELECT (SELECT count(*)::int FROM order_svc.address_mutations) AS o, (SELECT count(*)::int FROM carrier_svc.address_mutations) AS c')).rows[0];

describe('tool layer: enforcement by rung (Plan §1.2)', () => {
  it('AG-01 I1/I2 are code at every rung: another customer\'s order and shipment are invisible and unwritable', async () => {
    for (const rung of ['B0', 'B3'] as const) {
      const { call } = layer(rung, { id: 'TEST_r1_request', order_id: 'ord_1024', new_address_id: 'addr_001' }, undefined, undefined, 'cus_001');
      expect(await call('get_order', { order_id: 'ord_1024' })).toMatchObject({ outcome: 'rejected', code: 'NOT_FOUND' });
      expect(await call('get_shipment', { order_id: 'ord_1024' })).toMatchObject({ outcome: 'rejected', code: 'NOT_FOUND' });
      const w = await call('change_shipment_address', { ...W('addr_001'), order_id: 'ord_1024' });
      expect(w.outcome).toBe('refused'); // B0: no such shipment for this customer; B3: refused earlier, for want of consent
    }
    expect(await counts()).toEqual({ o: 0, c: 0 });
  });

  it('AG-02 B0 sends an unconfirmed write to a foreign address (I3/I5 are prompt); B2 refuses both and sends nothing', async () => {
    const b0 = layer('B0');
    expect(await b0.call('change_order_address', W('addr_001'))).toMatchObject({ outcome: 'ok' });
    expect(await counts()).toEqual({ o: 1, c: 0 });
    await seed(a.pool, fixture);
    const b2 = layer('B2');
    expect(await b2.call('change_order_address', W('addr_001'))).toMatchObject({ outcome: 'refused', code: 'ADDRESS_NOT_SAVED' });
    expect(await b2.call('change_order_address', W())).toMatchObject({ outcome: 'refused', code: 'CONSENT_REQUIRED' });
    expect(await counts()).toEqual({ o: 0, c: 0 });
    expect(b2.trace.events.filter((e) => e.kind === 'write').every((e) => !e.dispatched && e.actor === 'code')).toBe(true);
  });

  it('AG-03 B2 revalidates in code: fresh read, expected_version sent, ineligible refused, no-op skipped', async () => {
    const { call, trace } = layer('B2');
    expect(await call('request_customer_confirmation', { order_id: 'ord_1009', address_id: 'addr_006' })).toEqual({ confirmed: true });
    expect(await call('change_order_address', { order_id: 'ord_1009', address_id: 'addr_006' })).toMatchObject({ outcome: 'ok' });
    const w = trace.events.find((e) => e.kind === 'write' && e.dispatched)!;
    const before = trace.events[trace.events.indexOf(w) - 1]!;
    expect(before).toMatchObject({ kind: 'read', actor: 'code', result: 'ok', provider: 'order' });
    expect(w.expected_version).toBe(before.entity!.version);
    expect(await call('change_order_address', { order_id: 'ord_1009', address_id: 'addr_006' })).toMatchObject({ replayed: true }); // de-duplicated (B1+)
    await a.pool.query(`UPDATE order_svc.orders SET status = 'SHIPPED' WHERE id = 'ord_1008'`);
    const other = layer('B2', { id: 'TEST_r2_request', order_id: 'ord_1008', new_address_id: 'addr_006' });
    await other.call('request_customer_confirmation', { order_id: 'ord_1008', address_id: 'addr_006' });
    expect(await other.call('change_order_address', { order_id: 'ord_1008', address_id: 'addr_006' })).toMatchObject({ code: 'ORDER_NOT_ELIGIBLE' });
    expect(await counts()).toEqual({ o: 1, c: 0 });
  });

  it('AG-04 B1 keeps one unresolved change per order and never repeats a successful write', async () => {
    const shared = new SharedState();
    const first = layer('B1', MINE, shared);
    expect(await first.call('change_order_address', { order_id: 'ord_1009', address_id: 'addr_006', expected_version: null })).toMatchObject({ outcome: 'ok' });
    expect(await first.call('change_order_address', { order_id: 'ord_1009', address_id: 'addr_006', expected_version: null })).toMatchObject({ outcome: 'ok', replayed: true });
    const rival = layer('B1', { id: 'TEST_r1_competing', order_id: 'ord_1009', new_address_id: 'addr_005' }, shared);
    expect(await rival.call('request_customer_confirmation', { order_id: 'ord_1009', address_id: 'addr_005' })).toMatchObject({ code: 'ORDER_CHANGE_IN_PROGRESS' });
    expect(await rival.call('change_order_address', { order_id: 'ord_1009', address_id: 'addr_005', expected_version: null })).toMatchObject({ code: 'ORDER_CHANGE_IN_PROGRESS' });
    expect(await counts()).toEqual({ o: 1, c: 0 });
    await first.call('report_to_customer', { status: 'pending', message: 'working on it' });
    expect(shared.open.has('ord_1009')).toBe(false); // the accepted report resolves the request
  });

  it('AG-05 B3 refuses a report the verifier cannot confirm; needs_review is always accepted', async () => {
    const { call } = layer('B3');
    await call('request_customer_confirmation', { order_id: 'ord_1009', address_id: 'addr_006' });
    expect(await call('report_to_customer', { status: 'completed', message: 'done' })).toMatchObject({ outcome: 'refused', code: 'NOT_VERIFIED_IN_BOTH_SYSTEMS' });
    await call('change_order_address', { order_id: 'ord_1009', address_id: 'addr_006' });
    expect(await call('report_to_customer', { status: 'not_changed', message: 'no' })).toMatchObject({ outcome: 'refused', code: 'REQUESTED_ADDRESS_PRESENT' });
    await call('change_shipment_address', { order_id: 'ord_1009', address_id: 'addr_006' });
    expect(await call('report_to_customer', { status: 'completed', message: 'done' })).toEqual({ outcome: 'delivered_to_customer' });
    const other = layer('B3');
    expect(await other.call('report_to_customer', { status: 'needs_review', message: 'checking' })).toEqual({ outcome: 'delivered_to_customer' });
  });

  it('AG-06 tool arguments are validated in code, whatever the schema promised', async () => {
    const { tl } = layer('B0');
    const out = await tl.call('change_order_address', { order_id: "ord_1009' OR 1=1", address_id: 'addr_006', idempotency_key: null, expected_version: null });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content).error).toBe('INVALID_ARGUMENTS');
    expect(await counts()).toEqual({ o: 0, c: 0 });
  });
});

/** A scripted stand-in for the Messages API: returns `content` blocks per call, records every request. */
function scripted(turns: ((n: number) => Partial<Anthropic.Message>)[], seen: Anthropic.MessageCreateParamsNonStreaming[] = []): ModelClient {
  let n = 0;
  return {
    model: 'scripted-test',
    paid: false,
    async create(params) {
      seen.push(structuredClone(params));
      const make = turns[Math.min(n, turns.length - 1)]!;
      const m = { id: `msg_${n}`, type: 'message', role: 'assistant', model: 'scripted-test', stop_reason: 'tool_use', stop_sequence: null, content: [], usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, ...make(n) };
      n++;
      return m as unknown as Anthropic.Message;
    },
  };
}
const use = (n: number, name: string, input: unknown) => ({ type: 'tool_use', id: `toolu_${n}`, name, input }) as Anthropic.ToolUseBlock;
const spec = (deadline = Date.now() + 60_000) => ({ episode: 0, request_id: MINE.id, role: 'primary' as const, system: systemBlocks(), tools: [], userMessage: 'Request TEST', deadline });

describe('tool-use loop (ADR-0007)', () => {
  it('AG-07 history is append-only; the episode ends at the accepted report', async () => {
    const seen: Anthropic.MessageCreateParamsNonStreaming[] = [];
    const client = scripted([(n) => ({ content: [use(n, 'get_order', { order_id: 'ord_1009' })] }), (n) => ({ content: [use(n, 'report_to_customer', { status: 'pending', message: 'x' })] })], seen);
    const log = await runEpisode(client, layer('B0').tl, spec());
    expect(log).toMatchObject({ outcome: 'reported', reported: 'pending', message: 'x' });
    expect(seen).toHaveLength(2);
    expect(seen[1]!.messages.slice(0, seen[0]!.messages.length)).toEqual(seen[0]!.messages);
    expect(seen[0]).toMatchObject({ tool_choice: { type: 'auto' }, output_config: { effort: 'medium' }, max_tokens: LOOP.maxTokens });
    expect(seen[0]).not.toHaveProperty('thinking');
    expect(seen[0]).not.toHaveProperty('fallbacks');
  });

  it('AG-08 a refusal is an outcome and is not retried; no tool call is a protocol failure; the turn cap holds', async () => {
    const refusal = await runEpisode(scripted([() => ({ stop_reason: 'refusal', content: [] })]), layer('B0').tl, spec());
    expect(refusal).toMatchObject({ outcome: 'model_refusal', reported: null });
    expect(refusal.turns).toHaveLength(1);
    const silent = await runEpisode(scripted([() => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done!' } as Anthropic.TextBlock] })]), layer('B0').tl, spec());
    expect(silent.outcome).toBe('no_report');
    const busy = await runEpisode(scripted([(n) => ({ content: [use(n, 'list_saved_addresses', {})] })]), layer('B0').tl, spec());
    expect(busy).toMatchObject({ outcome: 'turn_cap' });
    expect(busy.turns).toHaveLength(LOOP.maxTurns);
  });

  it('AG-09 the paid-call gate: no client without --allow-paid, a known model and a budget within the cap', async () => {
    expect(() => createPaidClient({ model: 'claude-haiku-5-5', allowPaid: false, budgetUsd: 5 })).toThrow(/not allowed/);
    expect(() => createPaidClient({ model: 'claude-opus-5-5', allowPaid: true, budgetUsd: 5 })).toThrow(/ADR-0007/);
    expect(() => createPaidClient({ model: 'claude-haiku-5-5', allowPaid: true, budgetUsd: 176 })).toThrow(/budget/);
    expect(() => createPaidClient({ model: 'claude-haiku-5-5', allowPaid: true, budgetUsd: Number.NaN })).toThrow(/budget/);
    const meter = new BudgetMeter(1, 0.1);
    meter.add('claude-haiku-5-5', { input_tokens: 9_500_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 });
    expect(() => meter.assertCanCall()).toThrow(/budget stop/);
    // A budget stop inside the loop halts the run rather than becoming an episode outcome.
    const broke: ModelClient = { model: 'x', paid: true, create: async () => { meter.assertCanCall(); throw new Error('unreachable'); } };
    await expect(runEpisode(broke, layer('B0').tl, spec())).rejects.toThrow(/budget stop/);
  });
});

describe('end to end through the harness', () => {
  const naive = (id: string, rung: RungId = 'B0') => runCaseOnAgent(a, fixture, byId(id), 1, { deadlineMs: 60_000, clientTimeoutMs: 500, rung: RUNGS[rung], client: createNaiveClient(), variant: 'NAIVE' });

  it('EV-03 the NAIVE control produces the false claims the harness must catch', async () => {
    const tbw = scoreCaseRun(byId('RDEV-029'), await naive('RDEV-029')); // order write timed out before writing; told completed
    expect(tbw).toMatchObject({ claim: 'completed', truth: 'partial', false_success: true });
    expect(tbw.violations).toEqual(expect.arrayContaining(['I5', 'I8', 'I9', 'I11', 'I12']));
    const rej = scoreCaseRun(byId('RDEV-041'), await naive('RDEV-041')); // carrier refused after the order changed; told not_changed
    expect(rej).toMatchObject({ claim: 'not_changed', truth: 'partial', false_failure: true });
    const comp = scoreCaseRun(byId('RDEV-050'), await naive('RDEV-050')); // competing request ran to completion inside the primary
    expect(comp.violations).toEqual(expect.arrayContaining(['I6', 'I7']));
    const ok = scoreCaseRun(byId('RDEV-001'), await naive('RDEV-001'));
    expect(ok).toMatchObject({ claim: 'completed', truth: 'both', false_success: false, correct: false });
    expect(ok.procedure).toEqual(['claim_before_verification', 'write_before_consent', 'write_without_revalidation']);
  }, 60_000);

  it('EV-04 the same naive policy on B1 cannot duplicate or overlap: code blocks the competing request', async () => {
    const s = scoreCaseRun(byId('RDEV-050'), await naive('RDEV-050', 'B1'));
    expect(s.violations).not.toContain('I7');
    expect(s.violations).not.toContain('I6');
  }, 60_000);

  it('EV-05 variant C: a proposal runs through A\'s pipeline; a decline tells the customer not_changed', async () => {
    const propose = (c: { intent: { order_id: string; new_address_id: string } }) =>
      scripted([() => ({ content: [use(0, 'propose_address_change', { order_id: c.intent.order_id, address_id: c.intent.new_address_id })] })]);
    const ok = byId('RDEV-001');
    const raw = await runCaseOnVariantC(a, fixture, ok, 1, { deadlineMs: 60_000, client: propose(ok) });
    expect(scoreCaseRun(ok, raw)).toMatchObject({ claim: 'completed', truth: 'both', correct: true, violations: [] });
    expect(raw).toMatchObject({ variant: 'C', record_version: 2, selector: { kind: 'proposal' } });
    const bad = byId('RDEV-011');
    const decline = await runCaseOnVariantC(a, fixture, bad, 1, { deadlineMs: 60_000, client: scripted([() => ({ content: [use(0, 'decline', { reason: 'not your order' })] })]) });
    expect(scoreCaseRun(bad, decline)).toMatchObject({ claim: 'not_changed', correct: true });
  }, 60_000);
});
