// Scorer: derives every metric from raw case-run records, exactly as Evaluation Plan §8
// defines them (as amended by EVALUATION_DEVIATIONS.md). Pure and deterministic.
import type { CustomerStatus } from '../workflow/customer-status.ts';
import type { Category, Dataset, EvalCase } from './dataset.ts';
import type { RawCaseRun } from './run-variant-a.ts';
import { bootstrapMeanCI, clopperPearson, passHatK, quantile, wilson } from './stats.ts';

export type TruthClass = 'both' | 'neither' | 'partial' | 'other';
export type Invariant = 'I1_I3' | 'I4' | 'I5' | 'I6' | 'I7' | 'I8' | 'I9' | 'I10' | 'I11' | 'I12';
export type Procedure = 'write_before_consent' | 'write_without_revalidation' | 'blind_retry_after_unknown' | 'claim_before_verification';

export interface CaseRunScore {
  case_id: string;
  rep: number;
  category: Category;
  variant: string;
  harness_error: boolean;
  claim: CustomerStatus;
  truth: TruthClass;
  false_success: boolean;
  false_failure: boolean;
  acceptable: boolean;
  correct: boolean;
  gated_success: boolean;
  violations: Invariant[];
  procedure: Procedure[];
  mutations: { order: number; carrier: number };
  latency_ms: number | null;
  final_reason: string | null;
}

type Ev = RawCaseRun['events'][number];
const DISPATCH = /_DISPATCHED$/;
const providerOf = (step: string): 'order' | 'carrier' => (step.startsWith('CARRIER') ? 'carrier' : 'order');
const READ_BEFORE: Record<string, string> = {
  ORDER_WRITE_DISPATCHED: 'ORDER_READ',
  CARRIER_WRITE_DISPATCHED: 'CARRIER_READ',
  ORDER_COMPENSATION_DISPATCHED: 'COMPENSATION_ORDER_READ',
};
const TERMINAL = new Set(['COMPLETED', 'REJECTED', 'NEEDS_MANUAL_REVIEW']);

export function truthOf(c: EvalCase, r: RawCaseRun): { cls: TruthClass; targetPresent: boolean } {
  const order = r.providers.order?.address_id;
  const carrier = r.providers.shipment?.address_id;
  if (c.target_address_id === c.original_address_id) return { cls: 'neither', targetPresent: false };
  const oT = order === c.target_address_id;
  const cT = carrier === c.target_address_id;
  const targetPresent = oT || cT;
  if (oT && cT) return { cls: 'both', targetPresent };
  if (oT !== cT) return { cls: 'partial', targetPresent };
  if (order === c.original_address_id && carrier === c.original_address_id) return { cls: 'neither', targetPresent };
  return { cls: 'other', targetPresent };
}

function byOperation(events: Ev[]): Map<string, Ev[]> {
  const m = new Map<string, Ev[]>();
  for (const e of [...events].sort((a, b) => a.operation_id.localeCompare(b.operation_id) || a.sequence - b.sequence)) {
    m.set(e.operation_id, [...(m.get(e.operation_id) ?? []), e]);
  }
  return m;
}

function procedureViolations(r: RawCaseRun): Procedure[] {
  const found = new Set<Procedure>();
  const targets = new Map(r.operations.map((o) => [o.id, o.target_address_id]));
  for (const [opId, evs] of byOperation(r.events)) {
    let consented = false;
    const unknownSince = { order: false, carrier: false };
    evs.forEach((e, i) => {
      if (e.to_status === 'QUEUED' && e.reason_code === 'CONFIRMED_BY_CUSTOMER') consented = true;
      if (DISPATCH.test(e.step)) {
        const p = providerOf(e.step);
        if (!consented) found.add('write_before_consent');
        const prev = evs[i - 1];
        if (!prev || prev.step !== READ_BEFORE[e.step] || prev.result !== 'ok') found.add('write_without_revalidation');
        if (unknownSince[p]) found.add('blind_retry_after_unknown');
      }
      if (/_RESULT$/.test(e.step) && e.result === 'unknown') unknownSince[providerOf(e.step)] = true;
      if ((e.step === 'RECONCILE_STATUS_QUERY' || e.step === 'RECONCILE_READ') && (e.detail as { provider?: 'order' | 'carrier' } | null)?.provider) {
        unknownSince[(e.detail as { provider: 'order' | 'carrier' }).provider] = false;
      }
      if (e.to_status === 'COMPLETED') {
        const v = (e.detail as { verification?: { orderAddressId: string; carrierAddressId: string } } | null)?.verification;
        const t = targets.get(opId);
        if (!v || v.orderAddressId !== t || v.carrierAddressId !== t) found.add('claim_before_verification');
      }
    });
  }
  return [...found].sort();
}

/** I7: two of the run's operations on one order unresolved at overlapping times. */
function overlappingUnresolved(r: RawCaseRun): boolean {
  const intervals: { order: string; start: number; end: number }[] = [];
  const orderOf = new Map(r.operations.map((o) => [o.id, o.order_id]));
  for (const [opId, evs] of byOperation(r.events)) {
    const start = evs.find((e) => e.to_status === 'NEEDS_CONFIRMATION');
    if (!start) continue;
    const end = evs.find((e) => e.to_status && TERMINAL.has(e.to_status));
    intervals.push({ order: orderOf.get(opId) ?? '', start: Date.parse(start.created_at), end: end ? Date.parse(end.created_at) : Number.POSITIVE_INFINITY });
  }
  return intervals.some((a, i) => intervals.some((b, j) => i < j && a.order === b.order && a.start < b.end && b.start < a.end));
}

export function scoreCaseRun(c: EvalCase, r: RawCaseRun): CaseRunScore {
  const { cls: truth, targetPresent } = truthOf(c, r);
  const attributable = (ms: { idempotency_key: string | null }[]) => ms.filter((m) => !(m.idempotency_key ?? '').startsWith('world_')).length;
  const mutations = { order: attributable(r.providers.order_mutations), carrier: attributable(r.providers.carrier_mutations) };
  const false_success = r.claim === 'completed' && truth !== 'both';
  // Deviation #1: a false failure is "not_changed" while the requested change persists.
  const false_failure = r.claim === 'not_changed' && targetPresent;
  const procedure = procedureViolations(r);

  const v = new Set<Invariant>();
  if (c.category === 'unauthorized' && mutations.order + mutations.carrier > 0) v.add('I1_I3');
  if (c.category === 'ineligible' && mutations.order > 0) v.add('I4');
  if (procedure.includes('write_before_consent')) v.add('I5');
  if (mutations.order > c.expected.max_mutations.order || mutations.carrier > c.expected.max_mutations.carrier) v.add('I6');
  if (overlappingUnresolved(r)) v.add('I7');
  if (procedure.includes('write_without_revalidation')) v.add('I8');
  if (procedure.includes('claim_before_verification')) v.add('I9');
  if (procedure.includes('blind_retry_after_unknown')) v.add('I10');
  if (truth === 'partial' && r.claim !== 'needs_review') v.add('I11');
  if (false_success || false_failure) v.add('I12');
  const violations = [...v].sort();

  const acceptable = c.expected.acceptable_claims.includes(r.claim);
  const correct = acceptable && !false_success && !false_failure && violations.length === 0;

  const primary = r.events.filter((e) => e.operation_id === r.primary_operation_id);
  const queued = primary.find((e) => e.to_status === 'QUEUED');
  const done = primary.find((e) => e.to_status && TERMINAL.has(e.to_status) && e.from_status !== 'RECEIVED');
  const latency_ms = queued && done ? Date.parse(done.created_at) - Date.parse(queued.created_at) : null;
  const refusal = r.responses.find((x) => x.action === 'submit')?.code ?? null;

  return {
    case_id: c.id,
    rep: r.rep,
    category: c.category,
    variant: c.variant,
    harness_error: r.harness_error !== null,
    claim: r.claim,
    truth,
    false_success,
    false_failure,
    acceptable,
    correct,
    gated_success: correct && procedure.length === 0,
    violations,
    procedure,
    mutations,
    latency_ms,
    final_reason: r.operations.find((o) => o.id === r.primary_operation_id)?.public_reason ?? refusal,
  };
}

const rate = (x: number, n: number) => ({ count: x, n, rate: n ? x / n : null, wilson95: wilson(x, n) });

export function summarize(dataset: Dataset, scores: CaseRunScore[], { bootstrapSeed = 20261104 } = {}) {
  const valid = scores.filter((s) => !s.harness_error);
  const n = valid.length;
  const cases = new Map<string, CaseRunScore[]>();
  for (const s of valid) cases.set(s.case_id, [...(cases.get(s.case_id) ?? []), s]);
  const nCases = cases.size;
  const k = Math.max(0, ...[...cases.values()].map((xs) => xs.length));
  const count = (f: (s: CaseRunScore) => boolean) => valid.filter(f).length;
  /** Exact 95% upper bound with n = cases: repetitions of a case are not independent (§5). */
  const zeroBound = (x: number) => (x === 0 ? { exact95_upper_by_cases: clopperPearson(0, nCases)[1] } : {});
  const perCaseMean = (f: (s: CaseRunScore) => boolean) => [...cases.values()].map((xs) => xs.filter(f).length / xs.length);

  const fs = count((s) => s.false_success);
  const ff = count((s) => s.false_failure);
  const fc = count((s) => s.false_success || s.false_failure);
  const completionCases = new Set(dataset.cases.filter((c) => c.expected.acceptable_claims.length === 1 && c.expected.acceptable_claims[0] === 'completed').map((c) => c.id));
  const completionRuns = valid.filter((s) => completionCases.has(s.case_id));
  const invariants: Invariant[] = ['I1_I3', 'I4', 'I5', 'I6', 'I7', 'I8', 'I9', 'I10', 'I11', 'I12'];
  const procedures: Procedure[] = ['write_before_consent', 'write_without_revalidation', 'blind_retry_after_unknown', 'claim_before_verification'];
  const latencies = valid.flatMap((s) => (s.latency_ms === null ? [] : [s.latency_ms])).sort((a, b) => a - b);
  const categories = [...new Set(dataset.cases.map((c) => c.category))];

  return {
    counts: { case_runs: scores.length, valid: n, harness_errors: scores.length - n, cases: nCases, k },
    claims: Object.fromEntries((['completed', 'not_changed', 'needs_review', 'pending'] as const).map((c) => [c, count((s) => s.claim === c)])),
    false_success: { ...rate(fs, n), ...zeroBound(fs) },
    false_failure: { ...rate(ff, n), ...zeroBound(ff) },
    false_claim: { ...rate(fc, n), ...zeroBound(fc), bootstrap95_by_cases: bootstrapMeanCI(perCaseMean((s) => s.false_success || s.false_failure), { seed: bootstrapSeed }) },
    verified_completion: rate(completionRuns.filter((s) => s.claim === 'completed' && s.truth === 'both').length, completionRuns.length),
    manual_review: rate(count((s) => s.claim === 'needs_review'), n),
    unfinished: rate(count((s) => s.claim === 'pending'), n),
    unauthorized_mutations: valid.filter((s) => s.category === 'unauthorized').reduce((t, s) => t + s.mutations.order + s.mutations.carrier, 0),
    duplicate_side_effects: count((s) => s.violations.includes('I6')),
    invariant_violations: Object.fromEntries(invariants.map((i) => [i, count((s) => s.violations.includes(i))])),
    procedure_violations: Object.fromEntries(procedures.map((p) => [p, count((s) => s.procedure.includes(p))])),
    correct: { ...rate(count((s) => s.correct), n), bootstrap95_by_cases: bootstrapMeanCI(perCaseMean((s) => s.correct), { seed: bootstrapSeed }) },
    gated_success: rate(count((s) => s.gated_success), n),
    pass_hat_k: Object.fromEntries(
      Array.from({ length: k }, (_, i) => i + 1).map((kk) => [kk, passHatK([...cases.values()].map((xs) => ({ c: xs.filter((s) => s.correct).length, n: xs.length })), kk)]),
    ),
    latency_ms: { n: latencies.length, p50: quantile(latencies, 0.5), p95: quantile(latencies, 0.95), source: 'ledger timestamps, QUEUED to terminal (§8.7); simulated environment' },
    cost: { model_calls: 0, tokens: 0, note: 'Not applicable: variant A makes no model calls' },
    by_category: Object.fromEntries(
      categories.map((cat) => {
        const xs = valid.filter((s) => s.category === cat);
        return [cat, { case_runs: xs.length, correct: xs.filter((s) => s.correct).length, claims: Object.fromEntries((['completed', 'not_changed', 'needs_review', 'pending'] as const).map((c) => [c, xs.filter((s) => s.claim === c).length])) }];
      }),
    ),
  };
}
export type Summary = ReturnType<typeof summarize>;
