# Phase 05: Agent-directed and Hybrid Variants

- **Status:** **In progress.** The harness and variants are built; the no-model negative control has run. **No model has been called.** The cost pilot waits for the maintainer's credentials and approval.
- **Dates:** 2026-11-07 →
- **Branch:** `phase-05-model-variants`

## 1. Goal / research value
Build the model-directed ladder B0–B3 and hybrid variant C so they can be compared with variant A under identical cases, faults and scoring. Before spending anything, prove the harness reports false claims when a real system makes them. Phase 04 left that open (report §7).

## 2. Scope / non-goals
**In (this step):**
- the rung-scoped tools, trusted tool trace and hand-written loop for B0–B3 ([ADR-0011](../DECISIONS/ADR-0011-agent-harness-tools-and-trace.md));
- variant C's Action-Selector;
- the paid-call gate and budget meter;
- the NAIVE no-model negative control, run end to end on R-dev.

**Not yet:**
- the cost pilot (R-dev, Haiku, k = 2, all rungs; ADR-0007), which needs credentials and the maintainer's approval;
- the language set L;
- batching for C and L;
- the variant freeze, then R-conf and R-hold, then the confirmatory run.

## 3. Architecture & implementation

| Concern | Code |
| --- | --- |
| Written policy (identical at every rung) and the enforcement matrix | [src/agent/policy.ts](../../src/agent/policy.ts) |
| Nine tools; per-rung schemas and enforcement; argument validation | [src/agent/tools.ts](../../src/agent/tools.ts) |
| Trusted tool trace | [src/agent/trace.ts](../../src/agent/trace.ts) |
| The one tool-use loop (ADR-0007) | [src/agent/loop.ts](../../src/agent/loop.ts) |
| Paid-call gate, budget meter; prices | [src/agent/model-client.ts](../../src/agent/model-client.ts), [src/agent/pricing.ts](../../src/agent/pricing.ts) |
| Variant C selector | [src/agent/selector.ts](../../src/agent/selector.ts) |
| NAIVE negative control | [src/agent/naive.ts](../../src/agent/naive.ts) |
| Runners | [src/eval/run-agent.ts](../../src/eval/run-agent.ts) (B, NAIVE), [src/eval/run-variant-c.ts](../../src/eval/run-variant-c.ts) (C) |
| Scorer: tool-trace detectors, agent cost and protocol summary | [src/eval/score.ts](../../src/eval/score.ts) |
| CLI | `npm run eval -- --variant <A\|NAIVE\|B0…B3\|C> [--model …] [--dry-run \| --allow-paid --budget-usd N]` |

The Anthropic SDK is pinned at `@anthropic-ai/sdk@1.6.0`, with no agent framework.

## 4. Alternatives & trade-offs
See [ADR-0011](../DECISIONS/ADR-0011-agent-harness-tools-and-trace.md). Measurement choices the frozen plan did not settle for model variants are logged as [Deviation #2](../EVALUATION_DEVIATIONS.md), before any recorded model-variant run.

## 5. Reliability & security concerns
- **No paid call is possible by accident.** The client refuses to exist without `--allow-paid`, an ADR-0007 model and a budget at or under $175. A missing flag fails before any results directory or stack is created (checked). Tests use scripted clients only, and no scripted output is ever written to `results/`.
- **Model output is untrusted input.** Every tool argument is validated with zod at the tool boundary (AG-06). Identity never comes from the model (AG-01).
- **No secrets in evidence.** Credentials resolve through the SDK's normal chain and are never logged. Records hold tool traces and transcripts, not keys.
- **Refusal fallbacks are off by omission.** The SDK documentation recommends opting into server-side `fallbacks` on Sonnet 5.5. ADR-0007 deliberately does not, so a refusal is recorded as `model_refusal` and never answered by another model. Haiku 5.5 has no server-side fallback in any case.

## 6. Validation

```
npm run typecheck
npm test                                    # 22 files, 165 tests
npm run eval:score -- results/<each A run>  # both committed A runs: zero changed bytes
npm run eval -- --variant NAIVE --k 5       # the negative control (below)
```

New tests:
- **ST-01…08:** each tool-trace detector fires on a perturbed trace and is silent on a clean one.
- **AG-01…06:** rung enforcement in tool code, against the real providers.
- **AG-07…09:** the loop is append-only, records refusals without retrying, enforces protocol and turn caps, and keeps the paid-call gate shut.
- **EV-03…05:** NAIVE and C end to end through the harness.

### NAIVE negative control: predictions (pre-registered)
These were written from the policy code ([naive.ts](../../src/agent/naive.ts)), case by case, **before the recorded run**. The only earlier executions were four cases inside the test suite (EV-03/04). The policy is deterministic, so every repetition should match. Units are case-runs at k = 5 (cases × 5).

| Measure | Predicted | Why |
| --- | --- | --- |
| Claims | completed 190, not_changed 60 | `not_changed` exactly when a write is refused: another customer's order (RDEV-011…013, 404), a dispatched shipment (017…021, 043, 044) or carrier rejection (041, 042) |
| **False success** | **35** (7 cases) | Timeout before write, treated as sent: 029…034 (one system written). Address unchanged: 022 (truth is `neither` by definition, told `completed`) |
| **False failure** | **45** (9 cases) | The order changed, then the carrier refused: 017…021 (shipped or delivered; the order provider has no eligibility rule), 041…044 |
| **False claims** | **80 / 250 = 32.0%** | |
| Correct / gated success | 0 / 0 | Every case dispatches a write without consent (I5) or revalidation (I8) |
| Verified completion | 120 / 150 (80%) | Fails only on the 6 timeout-before-write cases |
| Unauthorized mutations | 30 | 014…016: one order and one carrier write each, to another customer's address |
| I1–I3 / I4 | 15 / 30 | I4: 017…022 changed an ineligible order |
| I5 / I8 | 250 / 250 | |
| I6 (duplicate side effects) | 95 (19 cases) | RDEV-014…028 and 047…050: writes where none were allowed (014…022, 047…049), the repeated request (023, 024), provider duplicate delivery without a key (025, 026), four concurrent agents (027, 028), and the competing request (050) |
| I7 | 5 (RDEV-050) | The competing request runs to completion inside the primary's span |
| I9 | 190 | Every `completed` is claimed without reads |
| I10 | 0 | The policy never retries |
| I11 | 75 (15 cases) | Every partial truth (017…021, 029…034, 041…044), told something other than `needs_review` |
| I12 | 80 | = false claims |
| Manual review / unfinished | 0 / 0 | |

*Results: see the next section.*

## 7. Limitations
To be completed at the gate.

## 8. Outcome / next decision
**Next:** the cost pilot (R-dev, Claude Haiku 5.5, k = 2, all four rungs, then C), once the maintainer provides credentials and approves the spend. `--dry-run` projects about $0.59 for one rung at k = 2 (118 episodes). That projection is rough, built from ADR-0007's assumed episode shape. The pilot replaces it with measured cost.
