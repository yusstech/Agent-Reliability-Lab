// Runs a variant A scenario end to end and records a deterministic trace (Phase 03
// evidence): ledger events without timestamps or secrets, the customer-visible claim,
// and the ground truth in both provider stores.
import { type Fixture, generateFixture } from '../../fixtures/generate.ts';
import { WORKFLOW_SCENARIOS, type WorkflowScenario } from '../../scenarios/workflow-scenarios.ts';
import { seed } from '../db/seed.ts';
import { pickTarget, type TraceTarget } from '../providers/trace.ts';
import { startVariantA, type VariantA } from './harness.ts';
import { SimulatedCrash } from './worker.ts';

const auth = (c: string) => ({ authorization: `Bearer mock_session_${c}` });

export async function runWorkflowTrace(a: VariantA, fixture: Fixture, scenario: WorkflowScenario, target: TraceTarget) {
  await seed(a.pool, fixture);
  for (const p of ['order', 'carrier'] as const) {
    const r = await a.admin[p].request('PUT', '/_dev/scenario', { scenario_id: scenario.id, ...(scenario[p] ?? {}) });
    if (r.kind !== 'ok') throw new Error(`could not load ${scenario.id} on ${p}`);
  }

  const submit = await a.app.inject({
    method: 'POST', url: '/v1/address-change-requests', headers: auth(target.customer_id),
    payload: { order_id: target.order_id, new_address_id: target.to_address_id, idempotency_key: `${scenario.id}_request` },
  });
  if (submit.statusCode !== 202) throw new Error(`${scenario.id}: submit returned ${submit.statusCode} ${submit.body}`);
  const created = submit.json();
  const confirm = await a.app.inject({ method: 'POST', url: `/v1/operations/${created.operation_id}/confirm`, headers: auth(target.customer_id), payload: { confirmation_token: created.confirmation.token } });
  if (confirm.statusCode !== 200) throw new Error(`${scenario.id}: confirm returned ${confirm.statusCode}`);

  let workerCrashed = false;
  if (scenario.crashAt) {
    let fired = false;
    const doomed = a.worker({ crashAt: (p, op) => !fired && p === scenario.crashAt && op.status === 'UPDATING_ORDER' && (fired = true) });
    try {
      await doomed.runUntilIdle();
    } catch (err) {
      if (!(err instanceof SimulatedCrash)) throw err;
      workerCrashed = true;
    }
    await a.pool.query(`UPDATE ledger.operations SET lease_expires_at = now() - interval '1 second' WHERE id = $1`, [created.operation_id]);
  }
  const steps = await a.worker().runUntilIdle();

  const view = (await a.app.inject({ method: 'GET', url: `/v1/operations/${created.operation_id}`, headers: auth(target.customer_id) })).json();
  const events = (await a.app.inject({ method: 'GET', url: `/v1/operations/${created.operation_id}/events`, headers: auth(target.customer_id) })).json().events;
  const q = async (sql: string, p: unknown[]) => (await a.pool.query(sql, p)).rows;
  const [order] = await q('SELECT address_id, version, status FROM order_svc.orders WHERE id = $1', [target.order_id]);
  const [shipment] = await q('SELECT address_id, version, status FROM carrier_svc.shipments WHERE carrier_ref = $1', [target.carrier_ref]);
  const [counts] = await q(`SELECT (SELECT count(*)::int FROM order_svc.address_mutations) AS order, (SELECT count(*)::int FROM carrier_svc.address_mutations) AS carrier`, []);
  for (const p of ['order', 'carrier'] as const) await a.admin[p].request('DELETE', '/_dev/scenario');

  const truthBoth = order.address_id === target.to_address_id && shipment.address_id === target.to_address_id;
  const truthNeither = order.address_id === target.from_address_id && shipment.address_id === target.from_address_id;
  return {
    scenario_id: scenario.id,
    fault: scenario.fault,
    title: scenario.title,
    worker_crashed: workerCrashed,
    worker_steps_after_recovery: steps,
    customer_told: view.customer_status as string,
    final_status: view.status as string,
    reason: view.reason as string | null,
    truth: { order, shipment, mutations: counts, both_changed: truthBoth, neither_changed: truthNeither },
    // Evaluation Plan §4.1: a false claim is "completed" without both systems changed, or
    // "not_changed" when either system changed. pending / needs_review are conservative.
    false_claim: (view.customer_status === 'completed' && !truthBoth) || (view.customer_status === 'not_changed' && !truthNeither),
    events: events.map(({ at: _at, ...e }: { at: string }) => e),
  };
}
export type WorkflowTrace = Awaited<ReturnType<typeof runWorkflowTrace>>;

/** Runs every workflow scenario on a fresh stack with deterministic operation ids. */
export async function generateWorkflowTraces(databaseUrl: string) {
  const fixture = generateFixture();
  const target = pickTarget(fixture);
  const traces: WorkflowTrace[] = [];
  for (const scenario of WORKFLOW_SCENARIOS) {
    const a = await startVariantA(databaseUrl, { requests: { newId: () => `op_${scenario.id.toLowerCase().replace(/[^a-z0-9]/g, '')}` } });
    try {
      traces.push(await runWorkflowTrace(a, fixture, scenario, target));
    } finally {
      await seed(a.pool, fixture);
      await a.close();
    }
  }
  return { fixture: { version: fixture.version, seed: fixture.seed }, client_timeout_ms: 150, traces };
}
