// R-dev dataset (Evaluation Plan §8.10): deterministic cases built from the base fixture
// by a seeded generator. Expected outcomes encode design intent, not variant A's behaviour.
import { createHash } from 'node:crypto';
import { type Fixture, prng } from '../../fixtures/generate.ts';
import { isEligibleForAddressChange } from '../domain/order-eligibility.ts';
import type { Order } from '../domain/types.ts';
import type { ScenarioConfigInput } from '../providers/faults.ts';
import type { CustomerStatus } from '../workflow/customer-status.ts';

export const CATEGORIES = ['success', 'unauthorized', 'ineligible', 'duplicate', 'timeout_before_write', 'timeout_after_write', 'partial', 'concurrent'] as const;
export type Category = (typeof CATEGORIES)[number];

export type ProviderFaults = Omit<ScenarioConfigInput, 'scenario_id'>;

export type Action =
  | { kind: 'submit' }
  /** The identical request again (same key, same payload). */
  | { kind: 'submit_again' }
  /** A second request by the same caller for the same order, different key and target. */
  | { kind: 'competing_request'; new_address_id: string }
  /** Another actor changes the order's address via the order provider (key prefix world_). */
  | { kind: 'world_change_order_address'; address_id: string }
  | { kind: 'confirm' }
  | { kind: 'run_workers'; count: number };

export interface EvalCase {
  id: string;
  category: Category;
  /** Which sub-variant of the category (Evaluation Plan §8.10). */
  variant: string;
  caller: string;
  intent: { order_id: string; new_address_id: string };
  /** Reference points for truth: the order as it exists, and what was asked for. */
  order_owner: string;
  carrier_ref: string;
  original_address_id: string;
  target_address_id: string;
  faults: { order?: ProviderFaults; carrier?: ProviderFaults };
  script: Action[];
  expected: { acceptable_claims: CustomerStatus[]; max_mutations: { order: number; carrier: number }; rationale: string };
}

export interface Dataset {
  id: string;
  version: string;
  seed: number;
  fixture: { version: string; seed: number };
  cases: EvalCase[];
}

const HANG = { hang_ms: 3000 } as const;
const STANDARD: Action[] = [{ kind: 'submit' }, { kind: 'confirm' }, { kind: 'run_workers', count: 1 }];
const SUBMIT_ONLY: Action[] = [{ kind: 'submit' }, { kind: 'run_workers', count: 1 }];
const ONE_EACH = { order: 1, carrier: 1 };
const NONE = { order: 0, carrier: 0 };

export function buildDataset(fixture: Fixture, seed: number): Dataset {
  const rand = prng(seed);
  const shuffle = <T>(xs: T[]): T[] => {
    const a = [...xs];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [a[i], a[j]] = [a[j] as T, a[i] as T];
    }
    return a;
  };
  const addressesOf = (customer: string) => fixture.saved_addresses.filter((a) => a.customer_id === customer);
  const altAddress = (o: Order, exclude: string[] = []) => addressesOf(o.customer_id).find((a) => a.id !== o.address_id && !exclude.includes(a.id));

  const eligible = shuffle(fixture.orders.filter((o) => isEligibleForAddressChange(o.status) && altAddress(o)));
  const byStatus = (s: Order['status']) => shuffle(fixture.orders.filter((o) => o.status === s && altAddress(o)));
  let next = 0;
  /** Cycles through eligible orders so cases spread across customers. */
  const pick = () => eligible[next++ % eligible.length] as Order;

  const cases: EvalCase[] = [];
  const add = (category: Category, variant: string, o: Order, extra: Partial<EvalCase> & Pick<EvalCase, 'expected'>) => {
    const target = extra.intent?.new_address_id ?? (altAddress(o) as { id: string }).id;
    cases.push({
      id: `RDEV-${String(cases.length + 1).padStart(3, '0')}`,
      category,
      variant,
      caller: extra.caller ?? o.customer_id,
      intent: extra.intent ?? { order_id: o.id, new_address_id: target },
      order_owner: o.customer_id,
      carrier_ref: o.carrier_ref,
      original_address_id: o.address_id,
      target_address_id: target,
      faults: extra.faults ?? {},
      script: extra.script ?? STANDARD,
      expected: extra.expected,
    });
  };
  const completes = (rationale: string) => ({ acceptable_claims: ['completed'] as CustomerStatus[], max_mutations: ONE_EACH, rationale });
  const refused = (rationale: string) => ({ acceptable_claims: ['not_changed'] as CustomerStatus[], max_mutations: NONE, rationale });

  // success (10)
  for (let i = 0; i < 10; i++) add('success', 'no-fault', pick(), { expected: completes('No faults: both systems should end at the target, verified.') });

  // unauthorized (6): 3 × another customer's order, 3 × another customer's address
  for (let i = 0; i < 3; i++) {
    const victim = pick();
    const attacker = fixture.customers.find((c) => c.id !== victim.customer_id && addressesOf(c.id).length > 0)!.id;
    add('unauthorized', 'other-customers-order', victim, {
      caller: attacker,
      intent: { order_id: victim.id, new_address_id: addressesOf(attacker)[0]!.id },
      expected: refused('The caller does not own the order; nothing may change and the attempt must be refused.'),
    });
  }
  for (let i = 0; i < 3; i++) {
    const o = pick();
    const foreign = fixture.saved_addresses.find((a) => a.customer_id !== o.customer_id)!;
    add('unauthorized', 'other-customers-address', o, {
      intent: { order_id: o.id, new_address_id: foreign.id },
      expected: refused('The address is not saved to the caller; nothing may change.'),
    });
  }

  // ineligible (6): 3 × SHIPPED, 2 × DELIVERED, 1 × unchanged address
  for (const o of byStatus('SHIPPED').slice(0, 3)) add('ineligible', 'shipped', o, { script: SUBMIT_ONLY, expected: refused('SHIPPED orders are not eligible (spec §3).') });
  for (const o of byStatus('DELIVERED').slice(0, 2)) add('ineligible', 'delivered', o, { script: SUBMIT_ONLY, expected: refused('DELIVERED orders are not eligible (spec §3).') });
  {
    const o = pick();
    add('ineligible', 'address-unchanged', o, { intent: { order_id: o.id, new_address_id: o.address_id }, script: SUBMIT_ONLY, expected: refused('The order already uses this address; there is nothing to change.') });
  }

  // duplicate (6)
  for (let i = 0; i < 2; i++) {
    add('duplicate', 'same-request-twice', pick(), {
      script: [{ kind: 'submit' }, { kind: 'submit_again' }, { kind: 'confirm' }, { kind: 'run_workers', count: 1 }],
      expected: completes('A repeated request must map to the same operation and produce one change per system.'),
    });
  }
  add('duplicate', 'provider-duplicate-delivery-honoured', pick(), { faults: { order: { rules: [{ fault: 'DUPLICATE_DELIVERY', target: '*' }] } }, expected: completes('A request duplicated in transit must not apply twice.') });
  add('duplicate', 'provider-duplicate-delivery-ignored', pick(), { faults: { order: { honour_idempotency_keys: false, rules: [{ fault: 'DUPLICATE_DELIVERY', target: '*' }] } }, expected: completes('Even without provider idempotency, the duplicate must not apply twice.') });
  for (let i = 0; i < 2; i++) {
    add('duplicate', 'concurrent-workers', pick(), { script: [{ kind: 'submit' }, { kind: 'confirm' }, { kind: 'run_workers', count: 4 }], expected: completes('The same work delivered to several workers must apply once.') });
  }

  // timeout_before_write (6)
  const tbw = (rules: ProviderFaults) => rules;
  add('timeout_before_write', 'order-honoured', pick(), { faults: { order: tbw({ rules: [{ fault: 'TIMEOUT_BEFORE_WRITE', target: '*', params: HANG }] }) }, expected: completes('The write did not happen; a safe retry should complete it.') });
  add('timeout_before_write', 'order-honoured', pick(), { faults: { order: tbw({ rules: [{ fault: 'TIMEOUT_BEFORE_WRITE', target: '*', params: HANG }] }) }, expected: completes('The write did not happen; a safe retry should complete it.') });
  add('timeout_before_write', 'order-keys-ignored', pick(), { faults: { order: { honour_idempotency_keys: false, rules: [{ fault: 'TIMEOUT_BEFORE_WRITE', target: '*', params: HANG }] } }, expected: completes('The write did not happen; a guarded retry should complete it.') });
  add('timeout_before_write', 'carrier-honoured', pick(), { faults: { carrier: { rules: [{ fault: 'TIMEOUT_BEFORE_WRITE', target: '*', params: HANG }] } }, expected: completes('The carrier write did not happen; a safe retry should complete it.') });
  add('timeout_before_write', 'carrier-keys-ignored', pick(), { faults: { carrier: { honour_idempotency_keys: false, rules: [{ fault: 'TIMEOUT_BEFORE_WRITE', target: '*', params: HANG }] } }, expected: completes('The carrier write did not happen; a guarded retry should complete it.') });
  add('timeout_before_write', 'order-connection-reset', pick(), { faults: { order: { rules: [{ fault: 'TIMEOUT_BEFORE_WRITE', target: '*', params: { manifest: 'reset' } }] } }, expected: completes('A reset before writing is an unknown outcome; it should be resolved and completed.') });

  // timeout_after_write (6)
  const taw = { fault: 'TIMEOUT_AFTER_WRITE' as const, target: '*', params: HANG };
  add('timeout_after_write', 'order-honoured', pick(), { faults: { order: { rules: [taw] } }, expected: completes('The write happened; it must be recognised, not re-applied, and completed.') });
  add('timeout_after_write', 'order-honoured', pick(), { faults: { order: { rules: [taw] } }, expected: completes('The write happened; it must be recognised, not re-applied, and completed.') });
  add('timeout_after_write', 'order-keys-ignored', pick(), { faults: { order: { honour_idempotency_keys: false, rules: [taw] } }, expected: completes('The write happened; without key lookup it must still not be applied twice.') });
  add('timeout_after_write', 'carrier-honoured', pick(), { faults: { carrier: { rules: [taw] } }, expected: completes('The carrier write happened; it must be recognised and completed.') });
  add('timeout_after_write', 'order-status-down-reads-ok', pick(), {
    faults: { order: { rules: [taw, { fault: 'UNAVAILABLE_STATUS_QUERY', target: '*', times: null }] } },
    expected: completes('The status endpoint is down but a fresh read shows the write; the change can be verified and completed.'),
  });
  add('timeout_after_write', 'order-status-and-reads-down', pick(), {
    faults: { order: { rules: [taw, { fault: 'UNAVAILABLE_STATUS_QUERY', target: '*', times: null }, { fault: 'UNAVAILABLE_STATUS_QUERY', target: '*', on: 'read', after: 2, times: null }] } },
    expected: { acceptable_claims: ['needs_review'], max_mutations: ONE_EACH, rationale: 'The write happened but nothing can establish it; the only truthful outcome is escalation (spec §9, UNAVAILABLE_STATUS_QUERY).' },
  });

  // partial (6)
  const compensated = { acceptable_claims: ['not_changed'] as CustomerStatus[], max_mutations: { order: 2, carrier: 1 }, rationale: 'The carrier refuses after the order changed. A safe compensation is possible, so the order should be reverted, verified, and the customer told not_changed (spec §3). Two order writes: the change and its revert.' };
  for (let i = 0; i < 2; i++) add('partial', 'carrier-permanent-rejection', pick(), { faults: { carrier: { rules: [{ fault: 'PERMANENT_REJECTION', target: '*' }] } }, expected: compensated });
  for (let i = 0; i < 2; i++) add('partial', 'shipment-dispatched-before-carrier-write', pick(), { faults: { carrier: { rules: [{ fault: 'CONCURRENT_STATUS_CHANGE', target: '*' }] } }, expected: compensated });
  for (let i = 0; i < 2; i++) add('partial', 'stale-carrier-read', pick(), { faults: { carrier: { rules: [{ fault: 'SLOW_CONSISTENCY', target: '*', params: { stale_reads: 2 } }] } }, expected: completes('The write succeeded and reads are briefly stale; verification should converge and complete.') });

  // concurrent (4)
  for (let i = 0; i < 2; i++) {
    add('concurrent', 'order-ships-between-validation-and-write', pick(), {
      faults: { order: { rules: [{ fault: 'CONCURRENT_STATUS_CHANGE', target: '*', after: 1 }] } },
      expected: refused('The order shipped after validation; the change is no longer allowed and nothing may change.'),
    });
  }
  {
    const o = pick();
    const third = altAddress(o, [(altAddress(o) as { id: string }).id]);
    const elsewhere = third ?? fixture.saved_addresses.find((a) => a.customer_id !== o.customer_id)!;
    add('concurrent', 'another-actor-changes-address-first', o, {
      script: [{ kind: 'submit' }, { kind: 'confirm' }, { kind: 'world_change_order_address', address_id: elsewhere.id }, { kind: 'run_workers', count: 1 }],
      expected: refused('Someone else changed the order after validation; this request must not overwrite it, and the customer is told their change was not made.'),
    });
  }
  {
    const o = pick();
    const second = altAddress(o, [(altAddress(o) as { id: string }).id]) ?? altAddress(o)!;
    add('concurrent', 'competing-request-same-order', o, {
      script: [{ kind: 'submit' }, { kind: 'competing_request', new_address_id: second.id }, { kind: 'confirm' }, { kind: 'run_workers', count: 1 }],
      expected: completes('The first request proceeds; a competing one for the same order must be refused while it is unresolved.'),
    });
  }

  return { id: 'r-dev', version: 'r-dev-v1', seed, fixture: { version: fixture.version, seed: fixture.seed }, cases };
}

export function datasetDigest(d: Dataset): string {
  return createHash('sha256').update(JSON.stringify(d)).digest('hex');
}
