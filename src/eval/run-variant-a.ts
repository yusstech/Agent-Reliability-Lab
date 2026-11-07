// Executes R-dev cases against variant A and records raw observations only (Evaluation
// Plan §8). Nothing here scores: score.ts derives every metric from these records.
import type { Fixture } from '../../fixtures/generate.ts';
import { seed } from '../db/seed.ts';
import type { CustomerStatus } from '../workflow/customer-status.ts';
import type { VariantA } from '../workflow/harness.ts';
import type { EvalCase } from './dataset.ts';

export interface RawCaseRun {
  case_id: string;
  rep: number;
  variant: 'A';
  started_at: string;
  finished_at: string;
  harness_error: string | null;
  deadline_hit: boolean;
  /** Every API call the script made, in order (no secrets). */
  responses: { action: string; status: number; code: string | null; operation_id: string | null }[];
  primary_operation_id: string | null;
  claim: CustomerStatus;
  operations: { id: string; order_id: string; target_address_id: string; status: string; public_reason: string | null }[];
  events: { operation_id: string; sequence: number; step: string; from_status: string | null; to_status: string | null; reason_code: string; result: string | null; error_code: string | null; detail: unknown; created_at: string }[];
  providers: {
    order: { address_id: string; version: number; status: string } | null;
    shipment: { address_id: string; version: number; status: string } | null;
    order_mutations: { id: number; idempotency_key: string | null; from_address_id: string; to_address_id: string }[];
    carrier_mutations: { id: number; idempotency_key: string | null; from_address_id: string; to_address_id: string }[];
  };
}

export interface RunOptions {
  deadlineMs: number;
  /** Poll interval while the worker waits out backoff. */
  idleMs?: number;
}

const auth = (c: string) => ({ authorization: `Bearer mock_session_${c}` });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runCaseOnVariantA(a: VariantA, fixture: Fixture, c: EvalCase, rep: number, opts: RunOptions): Promise<RawCaseRun> {
  const started = new Date();
  const responses: RawCaseRun['responses'] = [];
  let primary: string | null = null;
  let token: string | null = null;
  let refusalClaim: CustomerStatus | null = null;
  let harnessError: string | null = null;
  let deadlineHit = false;

  try {
    await seed(a.pool, fixture);
    for (const p of ['order', 'carrier'] as const) {
      const r = await a.admin[p].request('PUT', '/_dev/scenario', { scenario_id: c.id, ...(c.faults[p] ?? {}) });
      if (r.kind !== 'ok') throw new Error(`could not load ${p} faults`);
    }
    const key = `${c.id}_r${rep}_request`;
    const submit = async (action: string, body: Record<string, unknown>) => {
      const res = await a.app.inject({ method: 'POST', url: '/v1/address-change-requests', headers: auth(c.caller), payload: body });
      const json = res.json() as { operation_id?: string; confirmation?: { token: string }; error?: { code: string; operation_id?: string } };
      responses.push({ action, status: res.statusCode, code: json.error?.code ?? null, operation_id: json.operation_id ?? json.error?.operation_id ?? null });
      return { res, json };
    };

    for (const step of c.script) {
      if (step.kind === 'submit' || step.kind === 'submit_again') {
        const { res, json } = await submit(step.kind, { order_id: c.intent.order_id, new_address_id: c.intent.new_address_id, idempotency_key: key });
        if (step.kind === 'submit') {
          primary = json.operation_id ?? json.error?.operation_id ?? null;
          if (res.statusCode >= 400 && res.statusCode < 500) refusalClaim = 'not_changed';
        }
        if (json.confirmation?.token) token = json.confirmation.token;
      } else if (step.kind === 'competing_request') {
        await submit(step.kind, { order_id: c.intent.order_id, new_address_id: step.new_address_id, idempotency_key: `${c.id}_r${rep}_competing` });
      } else if (step.kind === 'world_change_order_address') {
        const now = await a.providers.order.get(c.order_owner, c.intent.order_id);
        if (now.kind !== 'ok') throw new Error('world actor could not read the order');
        const w = await a.providers.order.change(c.order_owner, c.intent.order_id, { address_id: step.address_id, idempotency_key: `world_${c.id}_r${rep}`, expected_version: now.body.order.version });
        responses.push({ action: step.kind, status: w.kind === 'ok' ? 200 : 0, code: w.kind === 'rejected' ? w.code : null, operation_id: null });
      } else if (step.kind === 'confirm') {
        if (!primary || !token) continue; // a refused request has nothing to confirm
        const res = await a.app.inject({ method: 'POST', url: `/v1/operations/${primary}/confirm`, headers: auth(c.caller), payload: { confirmation_token: token } });
        responses.push({ action: 'confirm', status: res.statusCode, code: (res.json() as { error?: { code: string } }).error?.code ?? null, operation_id: primary });
      } else if (step.kind === 'run_workers') {
        // Production defaults (§8.9): undefined backoff falls back to the worker's own default.
        const workers = Array.from({ length: step.count }, () => a.worker({ backoffMs: undefined }));
        const deadline = started.getTime() + opts.deadlineMs;
        for (;;) {
          const ran = await Promise.all(workers.map((w) => w.runOnce()));
          if (ran.some(Boolean)) continue;
          // Nothing claimable right now: done, or waiting out a backoff.
          const open = await a.pool.query(`SELECT count(*)::int AS n FROM ledger.operations WHERE status NOT IN ('COMPLETED','REJECTED','NEEDS_MANUAL_REVIEW')`);
          if (open.rows[0].n === 0) break;
          if (Date.now() > deadline) {
            deadlineHit = true;
            break;
          }
          await sleep(opts.idleMs ?? 25);
        }
      }
    }
  } catch (err) {
    harnessError = (err as Error).message;
  }

  // Observe. Everything below is read straight from the stores, never from responses.
  const q = async <T>(sql: string, params: unknown[] = []) => (await a.pool.query(sql, params)).rows as T[];
  const operations = await q<RawCaseRun['operations'][number]>('SELECT id, order_id, target_address_id, status, public_reason FROM ledger.operations ORDER BY created_at, id');
  const events = (
    await q<RawCaseRun['events'][number] & { created_at: Date }>(
      'SELECT operation_id, sequence, step, from_status, to_status, reason_code, result, error_code, detail, created_at FROM ledger.operation_events ORDER BY created_at, operation_id, sequence',
    )
  ).map((e) => ({ ...e, created_at: new Date(e.created_at).toISOString() }));
  const [order] = await q<{ address_id: string; version: number; status: string }>('SELECT address_id, version, status FROM order_svc.orders WHERE id = $1', [c.intent.order_id]);
  const [shipment] = await q<{ address_id: string; version: number; status: string }>('SELECT address_id, version, status FROM carrier_svc.shipments WHERE carrier_ref = $1', [c.carrier_ref]);
  const muts = (table: string) => q<RawCaseRun['providers']['order_mutations'][number]>(`SELECT id::int AS id, idempotency_key, from_address_id, to_address_id FROM ${table} ORDER BY id`);

  // The claim is what the customer is told, read through the customer-facing API (§8.2).
  let claim: CustomerStatus = 'pending';
  if (refusalClaim) claim = refusalClaim;
  else if (primary) {
    const view = await a.app.inject({ method: 'GET', url: `/v1/operations/${primary}`, headers: auth(c.caller) });
    if (view.statusCode === 200) claim = (view.json() as { customer_status: CustomerStatus }).customer_status;
  }

  for (const p of ['order', 'carrier'] as const) await a.admin[p].request('DELETE', '/_dev/scenario');
  return {
    case_id: c.id,
    rep,
    variant: 'A',
    started_at: started.toISOString(),
    finished_at: new Date().toISOString(),
    harness_error: harnessError,
    deadline_hit: deadlineHit,
    responses,
    primary_operation_id: primary,
    claim,
    operations,
    events,
    providers: { order: order ?? null, shipment: shipment ?? null, order_mutations: await muts('order_svc.address_mutations'), carrier_mutations: await muts('carrier_svc.address_mutations') },
  };
}
