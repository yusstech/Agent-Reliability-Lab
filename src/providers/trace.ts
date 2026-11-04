// Runs a named provider scenario and records a deterministic trace (Phase 02 evidence).
// The probe sequence is a fixed experiment, NOT a retry policy: it reads, writes once,
// and on an unknown outcome queries status and retries once, so every fault's
// observable behaviour shows up in the same shape.
import type pg from 'pg';
import type { Fixture } from '../../fixtures/generate.ts';
import type { ProviderScenario } from '../../scenarios/provider-faults.ts';
import { isEligibleForAddressChange } from '../domain/order-eligibility.ts';
import { type Outcome, ProviderClient } from './client.ts';

export interface TraceTarget {
  customer_id: string;
  order_id: string;
  carrier_ref: string;
  from_address_id: string;
  to_address_id: string;
}

/** First eligible order whose customer has another saved address to move to. */
export function pickTarget(fixture: Fixture): TraceTarget {
  for (const order of fixture.orders) {
    if (!isEligibleForAddressChange(order.status)) continue;
    const alt = fixture.saved_addresses.find((a) => a.customer_id === order.customer_id && a.id !== order.address_id);
    if (alt) {
      return { customer_id: order.customer_id, order_id: order.id, carrier_ref: order.carrier_ref, from_address_id: order.address_id, to_address_id: alt.id };
    }
  }
  throw new Error('fixture has no eligible order with an alternative address');
}

interface TraceStep {
  probe: number;
  step: string;
  request: string;
  outcome: Outcome<unknown>;
}

async function observe(pool: pg.Pool, t: TraceTarget) {
  const q = async (sql: string, params: unknown[]) => (await pool.query(sql, params)).rows;
  return {
    order: (await q('SELECT id, status, address_id, version FROM order_svc.orders WHERE id = $1', [t.order_id]))[0],
    shipment: (await q('SELECT carrier_ref, status, address_id, version FROM carrier_svc.shipments WHERE carrier_ref = $1', [t.carrier_ref]))[0],
    order_mutations: await q('SELECT id::int AS id, idempotency_key, from_address_id, to_address_id, from_version, to_version FROM order_svc.address_mutations WHERE order_id = $1 ORDER BY id', [t.order_id]),
    carrier_mutations: await q('SELECT id::int AS id, idempotency_key, from_address_id, to_address_id, from_version, to_version FROM carrier_svc.address_mutations WHERE carrier_ref = $1 ORDER BY id', [t.carrier_ref]),
  };
}

export interface TraceEnv {
  orderUrl: string;
  carrierUrl: string;
  /** Read-only view across both provider schemas: the world as it really is. */
  observer: pg.Pool;
  clientTimeoutMs: number;
}

export async function runScenarioTrace(env: TraceEnv, scenario: ProviderScenario, target: TraceTarget) {
  const admin = {
    order: new ProviderClient({ baseUrl: env.orderUrl, timeoutMs: 5000 }),
    carrier: new ProviderClient({ baseUrl: env.carrierUrl, timeoutMs: 5000 }),
  };
  for (const p of ['order', 'carrier'] as const) {
    const loaded = await admin[p].request('PUT', '/_dev/scenario', { scenario_id: scenario.id, ...(scenario[p] ?? {}) });
    if (loaded.kind !== 'ok') throw new Error(`could not load ${scenario.id} on ${p}: ${JSON.stringify(loaded)}`);
  }

  const before = await observe(env.observer, target);
  const steps: TraceStep[] = [];

  for (const [i, probe] of scenario.probes.entries()) {
    const probeNo = i + 1;
    const client =
      probe.provider === 'order'
        ? new ProviderClient({ baseUrl: env.orderUrl, timeoutMs: env.clientTimeoutMs, headers: { 'x-acting-customer-id': target.customer_id } })
        : new ProviderClient({ baseUrl: env.carrierUrl, timeoutMs: env.clientTimeoutMs });
    const base = probe.provider === 'order' ? `/orders/${target.order_id}` : `/shipments/${target.carrier_ref}`;
    const key = `${scenario.id}_probe${probeNo}`;
    const run = async (step: string, method: 'GET' | 'POST', path: string, body?: unknown) => {
      const outcome = await client.request<Record<string, unknown>>(method, path, body);
      steps.push({ probe: probeNo, step, request: `${method} ${path}`, outcome });
      return outcome;
    };

    const read = await run('read', 'GET', base);
    const entity = read.kind === 'ok' ? (Object.values(read.body)[0] as { version: number }) : undefined;
    const body = {
      address_id: target.to_address_id,
      idempotency_key: key,
      ...(probe.expectedVersion && entity ? { expected_version: entity.version } : {}),
    };
    const write = await run('write', 'POST', `${base}/address-changes`, body);
    if (write.kind === 'unknown') {
      await run('status_query', 'GET', `${base}/address-changes/${key}`);
      await run('retry_write', 'POST', `${base}/address-changes`, body);
    }
    await run('read_after_1', 'GET', base);
    await run('read_after_2', 'GET', base);
  }

  const after = await observe(env.observer, target);
  const ruleState = {
    order: await admin.order.request('GET', '/_dev/state'),
    carrier: await admin.carrier.request('GET', '/_dev/state'),
  };
  for (const p of ['order', 'carrier'] as const) await admin[p].request('DELETE', '/_dev/scenario');

  return {
    scenario_id: scenario.id,
    fault: scenario.fault,
    title: scenario.title,
    target,
    before,
    steps,
    after,
    mutation_counts: { order: after.order_mutations.length, carrier: after.carrier_mutations.length },
    rules_fired: {
      order: ruleState.order.kind === 'ok' ? (ruleState.order.body as { rules: { fault: string; fired: number }[] }).rules.map((r) => ({ fault: r.fault, fired: r.fired })) : null,
      carrier: ruleState.carrier.kind === 'ok' ? (ruleState.carrier.body as { rules: { fault: string; fired: number }[] }).rules.map((r) => ({ fault: r.fault, fired: r.fired })) : null,
    },
  };
}
export type ScenarioTrace = Awaited<ReturnType<typeof runScenarioTrace>>;
