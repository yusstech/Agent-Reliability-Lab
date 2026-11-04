# ADR-0006: Measure instruction vs enforcement with an agent ladder, and pre-register the analysis

- **Status:** Accepted
- **Date:** 2026-11-04
- **Phase:** 01 (design revision before Phase 02)
- **Amends:** [ADR-0001](ADR-0001-compare-three-architectures.md)

## Context
A design review of spec v0.2 found that the planned A/B/C comparison largely determined its own outcome:
- **A and C would be near-identical.** With structured intent as input, C's model has no real work on the reliability set.
- **B's result would be decided by unstated choices.** Which checks the "basic authorization" providers enforce, and how strong its prompt is, were not specified.
- **A is designed against the exact faults it is tested on.**
- **The headline metric was missing.** The title is about false *claims*, but only false success was measured, not false failure.
- **Fifty single runs can't support rate claims.**

The literature scan ([RELATED_WORK.md](../RELATED_WORK.md)) also found a same-name project that already toggles safeguards on and off against a no-safeguard, blind-retry baseline.

## Options considered
1. **Keep the three monolithic variants.** Simple, but the result is predictable and partly duplicates prior work.
2. **Safeguards on vs off.** This is what the prior project does. Its baseline isn't even *told* the rules, so it can't separate "the model didn't know" from "the model knew and still failed".
3. **An enforcement ladder** B0–B3. Every rung gets the full written policy, and rungs differ only in which invariants code enforces. A and C remain as anchors. Add pre-registered hypotheses, a structured status channel, held-out faults sampled after the freeze, k=5 repetitions, ≥2 models, and exact or paired statistics.

## Decision
Option 3, specified in [EVALUATION_PLAN.md](../EVALUATION_PLAN.md).

## Consequences
- More runs. A rough episode count, to be costed precisely in Phase 04: (4 rungs + C) × 2 models × 5 reps × (50 + 50 + ≥12 + ≥60) cases, which is about 8,600 model-driven episodes. Budget and model choice are resolved in [ADR-0007](ADR-0007-models-harness-and-budget.md): Haiku 5.5 is the primary model, Sonnet 5.5 is used only for confirmatory runs, the cap is $175, and a pilot runs first.
- Phase 02 providers need a pluggable fault interface broad enough for faults sampled from an external taxonomy, and a switch for honouring idempotency keys.
- Phase 03 needs a rule-based intent layer for A so that H4 compares like with like.
- Every variant must end with a structured customer status, which adds a `report_to_customer` tool for B.
- The study's claims narrow to the novelty listed in RELATED_WORK §6. Confirmations of prior work are labelled as such.

## Reversal trigger
- If the pilot shows that the B rungs are indistinguishable (all at zero violations, or all failing for reasons unrelated to enforcement, such as tool-call formatting), collapse the ladder to B0 and B3 and log the deviation.
- If the budget can't cover two models, run one and state the limitation. Don't cut repetitions below k=3.
