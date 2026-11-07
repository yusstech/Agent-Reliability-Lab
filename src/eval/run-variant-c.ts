// Variant C on the reliability set (Plan §1.2, H5): the selector turns the structured request
// into one typed action; variant A's deterministic path does everything else, and the claim
// is rendered from the ledger exactly as for A. Raw records keep A's shape plus the selector.
import type { Fixture } from '../../fixtures/generate.ts';
import type { ModelClient } from '../agent/loop.ts';
import { customerContext, select } from '../agent/selector.ts';
import type { VariantA } from '../workflow/harness.ts';
import type { EvalCase } from './dataset.ts';
import { userMessage } from './run-agent.ts';
import { type RawCaseRun, type RunOptions, runCaseOnVariantA } from './run-variant-a.ts';

export async function runCaseOnVariantC(a: VariantA, fixture: Fixture, c: EvalCase, rep: number, opts: RunOptions & { client: ModelClient }): Promise<RawCaseRun> {
  // Context comes from the customer's own seeded data; the model never sees provider results.
  const context = customerContext(
    fixture.orders.filter((o) => o.customer_id === c.caller),
    fixture.saved_addresses.filter((x) => x.customer_id === c.caller),
  );
  const request = { id: `${c.id}_r${rep}_request`, order_id: c.intent.order_id, new_address_id: c.intent.new_address_id };
  const { selection, log } = await select(opts.client, userMessage(request), context);

  let raw: RawCaseRun;
  if (selection.kind === 'proposal') {
    // The proposal replaces the intent; A's request path revalidates ownership, address and eligibility.
    raw = await runCaseOnVariantA(a, fixture, { ...c, intent: { order_id: selection.order_id, new_address_id: selection.address_id } }, rep, opts, 'C');
  } else {
    // Nothing is submitted. A clarification or decline tells the customer nothing changed;
    // no usable action leaves them with no answer (pending).
    raw = await runCaseOnVariantA(a, fixture, { ...c, script: [] }, rep, opts, 'C');
    raw.claim = selection.kind === 'none' ? 'pending' : 'not_changed';
  }
  if (log.outcome === 'api_error' && raw.harness_error === null) raw.harness_error = `model API error (infrastructure, §8.8): ${log.error}`;
  log.request_id = raw.primary_operation_id ?? 'none';
  return { ...raw, record_version: 2, model: opts.client.model, episodes: [log], selector: selection };
}
