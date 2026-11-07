# Implementation Roadmap

**Agent Reliability Lab · Investigation 001 · Roadmap v0.2**  
**Status:** Phase 01 passed (`c8bae58`); Phase 02 passed (`1161eaa`); Phase 03 passed (`50f784a`); Phase 04 passed (`6e2d862`); Phase 05 next. Evaluation Plan frozen at `eval-plan-v1.2`. No milestone is marked complete without a working artifact and logged evidence.

## Delivery principles

1. **Prove the simplest solution first.** Build a deterministic baseline before adding a model.
2. **Keep the study fair.** Same mock services, scenarios and intended outcomes for A/B/C.
3. **Separate intent from authorization.** Identity, ownership, confirmation and eligibility are server-owned.
4. **Treat ambiguous outcomes as unknown.** Timeouts are not proof that a mutation failed.
5. **Document as we build.** No phase is complete without tests and an updated phase report.
6. **Do not upgrade a hypothesis into a finding.** Only measured results support comparative claims.

## Phase 01 — Project Foundation & Contracts

**Goal:** Define the smallest consistent domain and get a testable API foundation running.

**Build:** TypeScript + Fastify API; PostgreSQL schema and migrations; types for customers, saved addresses, orders, shipments, operations and operation events; structured validation; deterministic fixtures; state transitions; server-controlled identity test fixture (explicitly mock authentication); health route.

**Decisions to record:** schema shape, isolation of mock identity from business validation, unique `(customer_id, idempotency_key)` constraint, approach for blocking overlapping unresolved operations, API and error envelope conventions.

**Evidence:** working boot command, migration output, schema tests, fixture seed determinism, request-validation tests, database constraints. Record actual runtime versions.

**Done when:** API starts locally; schema and fixture checks pass from a clean DB; invalid requests return stable errors; operation state rules are unit-tested; no live data or external writes.

**Document:** `docs/PHASES/PHASE-01-FOUNDATION.md`; ADRs for schema/concurrency choices; README gets first **verified** setup instructions.

**Avoid:** agent SDK, distributed workflow engine, frontend, live credentials. (Phase 05 uses no agent framework either; see ADR-0007.)

## Phase 02 — Independent Mock Providers & Fault Injection

**Goal:** Make failures controllable and reproducible, without changing test assertions.

**Build:** separate mock Order and Carrier services/stores; provider-specific status endpoints; version fields; a pluggable fault interface broad enough for externally sampled faults ([Evaluation Plan §3.2](EVALUATION_PLAN.md#32-held-out-faults-anti-overfitting)); a per-provider switch for honouring idempotency keys; configured fault modes: `NORMAL`, `TIMEOUT_BEFORE_WRITE`, `TIMEOUT_AFTER_WRITE`, `PERMANENT_REJECTION`, `SLOW_CONSISTENCY`, `CONCURRENT_STATUS_CHANGE`, `DUPLICATE_DELIVERY`, `UNAVAILABLE_STATUS_QUERY`. Record server-side mutation counters.

**Decisions to record:** how the simulated provider knows whether a timed-out write happened; how idempotency keys are scoped; how eventual consistency is modeled; how clock/time is controlled in tests.

**Evidence:** a reproducible before/after state trace for every fault mode; tests distinguishing timeout-before-write and timeout-after-write; independent provider storage checks.

**Done when:** each fault can be triggered deterministically with a named scenario ID/seed and assertions prove expected provider state; there are no hidden shared writes between services.

**Document:** `docs/PHASES/PHASE-02-MOCK-SERVICES.md`; provider API examples; record injection mechanism and known simulation limitations.

## Phase 03 — Deterministic Baseline

**Goal:** Establish a safe non-agent comparison, with recoverable execution.

**Build:** authenticated request API; a rule-based intent layer (A's language baseline for H4); explicit confirmation challenge; authorization/eligibility checks; durable operation ledger; worker with revalidation and lease/recovery; provider adapters; idempotency and retry policy; independent verifier; reconciliation; guarded compensation or escalation for partial failures; state history.

**Decisions to record:** transaction boundaries, claim/lease mechanics, handling of unknown prior side effects, order version conflicts, retry policy when provider idempotency isn't available.

**Evidence:** unit/integration tests for state transitions, ownership and permission checks, user confirmation, duplicate requests, worker restart and timeout-after-write recovery; representative event traces.

**Done when:** a user cannot update another user's order; `COMPLETED` only follows verification in both systems; ambiguous results stay pending or escalate; a crashed worker does not silently double-apply a mutation.

**Document:** `docs/PHASES/PHASE-03-DETERMINISTIC.md`; recorded decision trade-offs; actual curl requests/responses in README once run.

## Phase 04 — Reliability Evaluation Harness

**Goal:** Turn the implementation into a falsifiable, repeatable experiment.

**Build:** R-dev 50-case seeded dataset with structured ground truth, including the expected customer-visible status; the claim-accuracy, procedure and per-invariant metrics from the [Evaluation Plan](EVALUATION_PLAN.md); pass^k and paired-bootstrap analysis scripts; scenario runner; fixture reset; structured operation events; evaluator that compares intended and authoritative final states; exports in machine-readable format (`results/<run-id>/events.jsonl`, `cases.csv`, `summary.json`, `manifest.json`); automated metrics and failure classification.

**Decisions to record:** denominator for completion rate, what counts as false success, test isolation, source of wall-clock latency, how per-provider failures are classified.

**Evidence:** reproducible baseline runs on clean state; zero or documented failed assertions; actual measured success/failure/latency; run manifest containing commit SHA, versions, seed and date.

**Done when:** a reviewer can rerun the complete deterministic suite and regenerate a results table from raw events, including the timeout-after-write case.

**Document:** `docs/PHASES/PHASE-04-EVALUATION.md`; include known limitations and a failure investigation for each unexpected result.

## Phase 05 — Agent-directed & Hybrid Implementations

**Goal:** Compare model-directed execution with the deterministic baseline under controlled conditions.

**Build:** restricted model/tool interface, typed actions, model-side traces, controlled budgets; the agent-directed **ladder B0–B3**, with the same written policy at every rung and enforcement varying by rung ([ADR-0006](DECISIONS/ADR-0006-enforcement-ladder-and-preregistration.md)); a `report_to_customer` status tool; the hybrid variant C (Action-Selector); language set L, including injection through tool-returned data; Claude Haiku 5.5 (primary) and Claude Sonnet 5.5 (confirmatory only), 5 repetitions per case, through one hand-written tool loop ([ADR-0007](DECISIONS/ADR-0007-models-harness-and-budget.md)). Start with a cost pilot, and stay within the $175 cap. Then **freeze**, generate R-conf, sample R-hold, and run the confirmatory suite once.

**Decisions to record:** tool permission boundaries, model/provider/version and parameters, token/call budgets, max-step limits, approval handling, fallback strategy.

**Evidence:** recorded actual model calls, prompt/tool specs, versions and settings, tool traces, token usage, per-case outcome and reproducibility notes. Do **not** substitute manually simulated model output for agent evidence.

**Done when:** all three variants process equivalent scenarios and results distinguish language understanding from execution reliability; unsafe actions are blocked by trusted controls and captured in logs.

**Document:** `docs/PHASES/PHASE-05-MODEL-VARIANTS.md`; ADRs for tool scope/model choice; research limitations including stochastic effects.

## Pre-registration gate (before Phase 04 runs)

Freeze [EVALUATION_PLAN.md](EVALUATION_PLAN.md) at a tagged commit. Every later run manifest records its hash, and every subsequent change is a logged deviation.

## Phase 06 — Findings, Case Study & Publication

**Goal:** Turn technical evidence into a credible public product engineering study.

**Build:** comparative results tables; representative trace diagrams; failure case analysis; architecture and ADR summaries; cost/latency trade-offs; GitHub demonstration instructions; short article + long technical case study.

**Decisions to record:** where a deterministic workflow outperformed agents, where model flexibility helped, what could be generalized and what was simulated.

**Evidence:** every reported number traces to `results/<run-id>/` and a commit; diagrams correspond to actual implementation; unsupported claims are labeled hypotheses.

**Done when:** a reader can clone the repository, reproduce selected cases and inspect raw evidence; the article is clear about methods, limitations and outcomes.

**Document:** `docs/PHASES/PHASE-06-REPORT.md`; final `docs/RESEARCH_REPORT.md`; stable README links.

## Cross-phase definition of done (mandatory)

A phase is **not done** just because code was generated or a screenshot looks good. Confirm: (a) functionality runs from a clean environment; (b) automated tests validate the primary acceptance criteria; (c) failure behaviour is documented; (d) important alternatives/trade-offs are recorded in an ADR; (e) evidence and environment versions are preserved; (f) README reflects verified reality; and (g) a reviewer can follow the documented steps.

## Scope control

Do not build authentication infrastructure for production, real carrier integrations, a polished UI, payments, or multi-agent coordination for this experiment. Consider a durable workflow platform (e.g., Temporal) only if the simple DB-backed worker becomes a measured limitation. Avoid extending scenario coverage before the core 50-case dataset can be reproduced.

## Progress tracking

| Phase | Status | Evidence link | Next action |
| --- | --- | --- | --- |
| 01 Foundation | **Passed** (`c8bae58`) | [PHASE-01](PHASES/PHASE-01-FOUNDATION.md) | — |
| 02 Mock services | **Passed** (`1161eaa`) | [PHASE-02](PHASES/PHASE-02-MOCK-SERVICES.md) | — |
| 03 Deterministic | **Passed** (`50f784a`) | [PHASE-03](PHASES/PHASE-03-DETERMINISTIC.md) | — |
| 04 Evaluation harness | **Passed** (`6e2d862`) | [PHASE-04](PHASES/PHASE-04-EVALUATION.md) | — |
| 05 Model variants | Not started | — | Cost pilot; B0–B3 and C on R-dev; language set; freeze variants; R-conf and R-hold |
| 06 Publication | Not started | — | Follow phase 05 gate |
