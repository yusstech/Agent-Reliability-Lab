// Executes a case on a model-directed rung (B0–B3) or the NAIVE control, and records raw
// observations only (ADR-0010 §1, ADR-0011). Same isolation, faults, deadline and truth
// reads as variant A; the claim is the primary episode's accepted report_to_customer.
import type Anthropic from '@anthropic-ai/sdk';
import type { Fixture } from '../../fixtures/generate.ts';
import { type EpisodeLog, type ModelClient, runEpisode } from '../agent/loop.ts';
import { POLICY, type Rung } from '../agent/policy.ts';
import { type Request, SharedState, ToolLayer, toolDefinitions } from '../agent/tools.ts';
import { TraceRecorder } from '../agent/trace.ts';
import { ProviderClient } from '../providers/client.ts';
import type { CustomerStatus } from '../workflow/customer-status.ts';
import type { VariantA } from '../workflow/harness.ts';
import type { EvalCase } from './dataset.ts';
import { clearFaults, observeStores, prepareCase, type RawCaseRun } from './run-variant-a.ts';

export interface AgentRunOptions {
  deadlineMs: number;
  clientTimeoutMs: number;
  rung: Rung;
  client: ModelClient;
  /** Recorded as the record's variant (B0…B3, or NAIVE). */
  variant: string;
}

/** The cached prefix: identical bytes for every episode of a rung (ADR-0007 caching). */
export function systemBlocks(): Anthropic.TextBlockParam[] {
  return [{ type: 'text', text: POLICY, cache_control: { type: 'ephemeral' } }];
}

/** Every variant receives the same structured intent on the reliability sets (Plan §3.1). */
export function userMessage(r: Request): string {
  return `Request ${r.id} from the store app (structured): change the delivery address of order ${r.order_id} to the customer's saved address ${r.new_address_id}.`;
}

export async function runCaseOnAgent(a: VariantA, fixture: Fixture, c: EvalCase, rep: number, o: AgentRunOptions): Promise<RawCaseRun> {
  const started = new Date();
  const deadline = started.getTime() + o.deadlineMs;
  const trace = new TraceRecorder();
  const shared = new SharedState();
  const episodes: EpisodeLog[] = [];
  const tools = toolDefinitions(o.rung);
  const system = systemBlocks();
  let harnessError: string | null = null;

  const clients = {
    order: new ProviderClient({ baseUrl: a.pair.orderUrl, timeoutMs: o.clientTimeoutMs, headers: { 'x-acting-customer-id': c.caller } }),
    carrier: new ProviderClient({ baseUrl: a.pair.carrierUrl, timeoutMs: o.clientTimeoutMs }),
  };
  const primary: Request = { id: `${c.id}_r${rep}_request`, order_id: c.intent.order_id, new_address_id: c.intent.new_address_id };
  let nextEpisode = 0;

  const episode = async (req: Request, role: EpisodeLog['role'], fireHooks: () => Promise<void>) => {
    const n = nextEpisode++;
    const layer = new ToolLayer({
      rung: o.rung,
      customerId: c.caller,
      request: req,
      episode: n,
      trace,
      clients,
      pool: a.pool,
      shared,
      // The simulated customer confirms exactly the change they asked for, and nothing else.
      customerConfirms: (orderId, addressId) => orderId === req.order_id && addressId === req.new_address_id,
      fireHooks,
    });
    trace.record({ request_id: req.id, episode: n, turn: 0, actor: 'customer', kind: 'received', tool: null, provider: null, address_id: req.new_address_id, order_id: req.order_id, result: 'ok', code: null, dispatched: false, key: null, expected_version: null, entity: null, status: null });
    const log = await runEpisode(o.client, layer, { episode: n, request_id: req.id, role, system, tools, userMessage: userMessage(req), deadline });
    episodes.push(log);
    return log;
  };

  // Scripted world events (Plan §8.10) fire once, at the primary request's first consent or
  // first write, whichever comes first, or at the end of its episodes if neither happens.
  // That mirrors variant A's script, where they occur after the request and before the work.
  let fired = false;
  const fireHooks = async () => {
    if (fired) return;
    fired = true;
    for (const step of c.script) {
      if (step.kind === 'world_change_order_address') {
        const owner = new ProviderClient({ baseUrl: a.pair.orderUrl, timeoutMs: o.clientTimeoutMs, headers: { 'x-acting-customer-id': c.order_owner } });
        const now = await owner.request<{ order: { version: number } }>('GET', `/orders/${encodeURIComponent(c.intent.order_id)}`);
        if (now.kind !== 'ok') throw new Error('world actor could not read the order');
        const w = await owner.request('POST', `/orders/${encodeURIComponent(c.intent.order_id)}/address-changes`, { address_id: step.address_id, idempotency_key: `world_${c.id}_r${rep}`, expected_version: now.body.order.version });
        trace.record({ request_id: 'world', episode: -1, turn: 0, actor: 'world', kind: 'world', tool: null, provider: 'order', address_id: step.address_id, order_id: c.intent.order_id, result: w.kind === 'ok' ? 'ok' : w.kind, code: w.kind === 'rejected' ? w.code : null, dispatched: true, key: `world_${c.id}_r${rep}`, expected_version: now.body.order.version, entity: null, status: null });
      } else if (step.kind === 'competing_request') {
        const competing: Request = { id: `${c.id}_r${rep}_competing`, order_id: c.intent.order_id, new_address_id: step.new_address_id };
        await episode(competing, 'competing', async () => {});
      }
    }
  };

  try {
    await prepareCase(a, fixture, c);
    const workers = c.script.find((s) => s.kind === 'run_workers');
    const count = workers && workers.kind === 'run_workers' ? workers.count : 1;
    // The same request delivered to `count` agents at once (the B analogue of several workers).
    await Promise.all(Array.from({ length: count }, () => episode(primary, 'primary', fireHooks)));
    await fireHooks();
    // The identical request again, after the first was handled (a client retry).
    if (c.script.some((s) => s.kind === 'submit_again')) await episode(primary, 'duplicate', async () => {});
  } catch (err) {
    if ((err as Error).name === 'BudgetExceededError' || (err as Error).name === 'PaidCallsNotAllowedError') throw err;
    harnessError = (err as Error).message;
  }
  const apiError = episodes.find((e) => e.outcome === 'api_error');
  if (!harnessError && apiError) harnessError = `model API error (infrastructure, §8.8): ${apiError.error}`;

  const observed = await observeStores(a.pool, c);
  await clearFaults(a);

  const first = episodes.filter((e) => e.request_id === primary.id).sort((x, y) => x.episode - y.episode)[0];
  const claim: CustomerStatus = first?.reported ?? 'pending';
  const requests = [primary, ...(c.script.some((s) => s.kind === 'competing_request') ? [{ id: `${c.id}_r${rep}_competing`, order_id: c.intent.order_id, new_address_id: (c.script.find((s) => s.kind === 'competing_request') as { new_address_id: string }).new_address_id }] : [])];
  const ops = requests.map((r) => {
    const e = episodes.filter((x) => x.request_id === r.id).sort((x, y) => x.episode - y.episode)[0];
    return { id: r.id, order_id: r.order_id, target_address_id: r.new_address_id, status: e?.reported ?? 'NOT_REPORTED', public_reason: e?.outcome ?? null };
  });

  return {
    case_id: c.id,
    rep,
    variant: o.variant,
    started_at: started.toISOString(),
    finished_at: new Date().toISOString(),
    harness_error: harnessError,
    deadline_hit: episodes.some((e) => e.outcome === 'deadline'),
    responses: [],
    primary_operation_id: primary.id,
    claim,
    operations: ops,
    events: observed.events,
    providers: observed.providers,
    record_version: 2,
    model: o.client.model,
    trace: trace.events,
    episodes: episodes.sort((x, y) => x.episode - y.episode),
  };
}
