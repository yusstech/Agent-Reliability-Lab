# ADR-0011: Agent harness: rung-scoped tools, a trusted tool trace, and a no-model control

- **Status:** Accepted
- **Date:** 2026-11-07
- **Phase:** 05
- **Builds on:** [ADR-0006](ADR-0006-enforcement-ladder-and-preregistration.md) (ladder), [ADR-0007](ADR-0007-models-harness-and-budget.md) (models, loop, budget), [ADR-0010](ADR-0010-evaluation-harness.md) (raw-first records)

## Context
Variants B0–B3 and C must be scored by the same scorer and definitions as variant A ([Plan §8](../EVALUATION_PLAN.md#8-measurement-definitions-v12)). B has no ledger: a model sequences tools, so "what happened, in what order" must come from somewhere the model cannot write. The Plan also fixes which invariants code enforces at each rung (§1.2), and ADR-0007 fixes the loop. Four questions were left open:
1. Where B's procedure evidence comes from.
2. Where each rung's enforcement lives.
3. How scripted case steps (duplicates, competing requests, other actors) apply to an agent.
4. How to prove the harness reports false claims before any money is spent (Phase 04 report §7).

## Options considered
1. **Score B from the model's transcript.** Cheap, but the evidence would be model text, which §4.2 forbids ("never from model text").
2. **Give B a ledger, as A has.** It would make B partly deterministic and blur what the ladder measures.
3. **A trusted tool trace** written by the tool code at the moment it acts, plus a versioned scorer that reads it. ADR-0010's reversal trigger asks for exactly this: version the record and the scorer together, don't fork the scorer.

## Decision
Option 3, as follows.

**Tools** ([`src/agent/tools.ts`](../../src/agent/tools.ts)). Nine tools at every rung: `get_order`, `get_shipment`, `list_saved_addresses`, `change_order_address`, `change_shipment_address`, `get_order_change_status`, `get_shipment_change_status`, `request_customer_confirmation`, `report_to_customer`. Their schemas and enforcement follow the matrix:

| Rung | Code enforces | How |
| --- | --- | --- |
| all | I1, I2 | The order client is fixed to the session customer. Shipments are reached only through an order the customer owns (an entitlement lookup in the database, so it consumes no provider fault budget). |
| B0 | — | Write tools take optional `idempotency_key` and `expected_version`. The model decides. |
| B1 | + I6, I7 | The tool derives a stable key per (request, system, order, address), returns the earlier result of a write that already succeeded, and refuses a change while another request holds the order (`ORDER_CHANGE_IN_PROGRESS`). `expected_version` stays optional. |
| B2 | + I3, I4, I5, I8 | Before sending: the address must be saved to the customer; the customer must have confirmed this order and address (a revert to the original address is allowed after a confirmed change); the order must be `PLACED`/`PACKING`; then the tool reads the record and sends its version as `expected_version`. Already at the address: nothing is sent. |
| B3 | + I9, I12 | `report_to_customer` re-reads both systems. It refuses `completed` unless both hold the target, and refuses `not_changed` if either system now holds the target because of this request. `needs_review` and `pending` are always accepted. |

Every rung receives the same policy text ([`src/agent/policy.ts`](../../src/agent/policy.ts)), byte for byte. Tool descriptions say truthfully what the tool does at that rung and carry MCP-style hints (`readOnlyHint`, `destructiveHint`, `idempotentHint`) in the description text. The Messages API has no annotation field. All arguments are validated in code with zod: `strict: true` constrains shape, not content. Optional arguments are required-and-nullable, because strict mode does not support pattern or length constraints.

**Trace** ([`src/agent/trace.ts`](../../src/agent/trace.ts)). Each event records the request, episode, model turn, actor (`model`, `code`, `customer`, `world`), kind, provider, outcome, whether a request was actually dispatched, and the key and version sent. The scorer's B detectors read it ([Deviation #2](../EVALUATION_DEVIATIONS.md)). Records gain `record_version: 2`, `trace` and `episodes`. Variant A's records are unchanged and re-score byte-identically.

**Loop** ([`src/agent/loop.ts`](../../src/agent/loop.ts)). It follows ADR-0007: at most 12 turns; `max_tokens` 8 192 per request; `effort: "medium"`; `thinking` omitted (adaptive by default); `tool_choice: auto`; strict tools; no `fallbacks` parameter (refusal fallbacks off). History is append-only. Parallel tool calls run in the order given. Every turn's `usage` is logged, with thinking signatures dropped from the *log* only, never from the history sent back. Outcomes: `reported`, `no_report` (protocol failure), `turn_cap`, `max_tokens`, `model_refusal`, `deadline`, `api_error`. An API error after the SDK's two retries marks the case-run `harness_error`, as for any other infrastructure failure (§8.8).

**Paid-call gate** ([`src/agent/model-client.ts`](../../src/agent/model-client.ts)). The Anthropic client can only be built with `--allow-paid`, a model from ADR-0007, and a `--budget-usd` no higher than the $175 study cap. A meter prices each call from its logged usage, and the run stops before a call that could cross the budget. `--dry-run` prints the episode count and a projected cost without credentials.

**Variant C** ([`src/agent/selector.ts`](../../src/agent/selector.ts)). One call maps the message, plus the customer's own orders and saved addresses as context, to exactly one of `propose_address_change`, `request_clarification` or `decline`. A proposal replaces the case intent and goes through variant A's request path, which revalidates every field. The customer status is rendered from the ledger. The model never sees provider results.

**NAIVE control** ([`src/agent/naive.ts`](../../src/agent/naive.ts)). A scripted policy behind the same `ModelClient` interface, run on B0's tools through the identical loop, runner and scorer. It writes the order, then the carrier, with no reads, consent, keys or versions. It trusts acknowledgements, treats a timeout as sent, and never verifies or compensates. It costs nothing, and its outcomes can be predicted case by case from the code, so its run checks the harness end to end. Its manifest and report are labelled as a negative control. It is never evidence about agents.

## Consequences
- The procedure metrics for A and B are comparable in meaning but computed from different evidence: A's ledger, B's tool trace. The write-up says so.
- The tool trace makes B's evidence independent of the model: a model that claims it verified, but did not, is caught by the absence of reads.
- Rung differences are in one file. A reviewer can check the matrix against code in a single read.
- C costs one call per case-run and is batchable, which ADR-0007 asks for. Batching is **not yet implemented**; the pilot runs C interactively.
- The language set L, the freeze, R-conf and R-hold remain to do in Phase 05.

## Reversal trigger
- The pilot shows a detector firing on behaviour that is clearly correct (for example, the earlier-turn rule penalising a reasonable read pattern). Fix the definition as a logged deviation before the confirmatory run, never after.
- Haiku cannot operate the tools at all. ADR-0007's own trigger then applies.
