# ADR-0010: Evaluation harness: raw-first records, pure scoring, design-intent ground truth

- **Status:** Accepted
- **Date:** 2026-11-04
- **Phase:** 04

## Context
Phase 04 turns the implementation into a falsifiable experiment ([roadmap](../IMPLEMENTATION_ROADMAP.md)). A reviewer must be able to rerun the suite and **regenerate every reported number from raw events**. The same harness must later score variants B and C under the same definitions. The [Evaluation Plan](../EVALUATION_PLAN.md) was frozen (tag `eval-plan-v1.2`) before this harness existed.

## Decisions

### 1. Raw first, scores derived
The runner records only observations, one JSON line per case-run in `events.jsonl`:
- every API response;
- the full ledger;
- both providers' mutation logs and end state.

A **pure** scorer derives `cases.csv`, `summary.json` and `report.md` from those lines, and `npm run eval:score` regenerates them at any time. *Rejected:* computing metrics during the run. A scorer bug would then be baked into the evidence, and fixing it would mean rerunning everything.

### 2. Ground truth comes from the stores, and the claim from the customer API
Truth is read straight from both provider tables at the end of each case-run. The claim is read through `GET /v1/operations/:id`, which is exactly what a customer sees. Nothing is inferred from the system's own logs of what it did.

### 3. Expected outcomes encode design intent, written before measurement
Each case states its `acceptable_claims` and `max_mutations`, with a rationale, derived from the spec. They are not derived from what variant A does. If A disagrees with a case, that counts against A, not a reason to edit the case.

### 4. Isolation by reseeding, and one sequential stack
Case-runs execute sequentially in one in-process stack (API, both providers, worker). The fixture is reseeded and the fault engines reset before each one. *Rejected:* parallel case-runs. They would add nondeterminism, and the variant A runtime is short.

### 5. Intervals respect the unit of analysis
Repetitions of a case are correlated. Bootstrap intervals therefore resample cases, and the exact upper bound reported for zero observed events uses *n = cases*, not *n = case-runs*. Reporting "0 of 250" as if it were 250 independent trials would overstate certainty five-fold.

### 6. Committed evidence
Official runs under `results/<run-id>/` are committed, so every number in a document traces to a file and a commit. `results/scratch/` is ignored. A run's manifest records:
- the commit, and whether the tree was dirty;
- the dataset hash;
- the plan hash, compared against the frozen tag;
- the runtime versions.

## Consequences
- Variants B and C need only a runner that produces the same raw record shape. Scoring is shared, so the comparison is like for like.
- `events.jsonl` is large, about 1 MB per 250 case-runs. That is acceptable for the evidence value.

## Reversal trigger
If the B and C runners can't produce comparable raw records (for example, because model traces need a different structure), version the record schema and the scorer together. Don't fork the scorer.
