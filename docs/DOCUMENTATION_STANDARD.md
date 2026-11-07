# Documentation Standard

**Purpose:** Make each design choice and test result defensible, searchable and reusable for an engineering portfolio, technical product case study, and public research writing.

## What belongs where

| Document | File | Update trigger |
| --- | --- | --- |
| Public entry point, real setup and current status | `README.md` | Every phase gate or any setup change |
| Requirements, boundaries, contracts | `docs/PROTOTYPE_SPEC.md` | A reviewed change in product rules or APIs |
| Roadmap, planned deliverables and gates | `docs/IMPLEMENTATION_ROADMAP.md` | Phase starts/completions or scope decisions |
| Current architecture and trust boundaries | `docs/ARCHITECTURE.md` | Relevant implementation or architecture decision |
| ADRs explaining non-obvious decisions | `docs/DECISIONS/ADR-XXXX-*.md` | Before/with the decision, not retrospectively |
| Phase log + evidence | `docs/PHASES/PHASE-XX-*.md` | Throughout the phase; finalize at gate |
| Experiment methods, definitions, sampling | `docs/EVALUATION_PLAN.md` | Before executing the comparative suite |
| Raw experimental observations | `results/<run-id>/` | Each test run, ideally exported by automation |
| Research narrative + verified findings | `docs/RESEARCH_REPORT.md` (planned) | After analyzing actual runs |

## The eight-part phase record

Each `PHASE-XX` document must answer these questions with specific evidence:

1. **Goal / user or research value** — What question does the phase help answer?
2. **Scope / non-goals** — What was included and intentionally left out?
3. **Architecture & implementation** — What was actually built? Link to code/diagram/contract.
4. **Alternatives & trade-offs** — What options were rejected, and why? Link ADRs.
5. **Reliability & security concerns** — Failure modes, authorization boundaries, data sensitivity.
6. **Validation** — Exact commands, test IDs, expected vs observed results, logs/trace links.
7. **Limitations** — Known bugs, coverage gaps, assumptions and dependencies.
8. **Outcome / next decision** — Did the phase gate pass? What is next? What changed in your thinking?

Use [PHASE_REPORT_TEMPLATE](TEMPLATES/PHASE_REPORT_TEMPLATE.md). A phase is marked `Complete` only when supporting evidence exists.

## Decision records (ADRs)

Prefer small decisions with one clear trade-off each, not long retrospective essays. Use status `Proposed`, `Accepted`, `Superseded` or `Rejected`. Explain context, 2+ alternatives, chosen path, consequences, and **reversal trigger** (what observation would make us reconsider). ADRs describe **design rationale**, not proof of performance.

Example: `ADR-0001-compare-three-architectures.md` explains why we compare A/B/C rather than assume the hybrid approach wins.

## Evidence protocol for experiments

For each run, record:

- **Identity:** run ID, UTC timestamp, git commit, branch, operator, scenario dataset version and seed.
- **Environment:** Node/Postgres/runtime versions, relevant OS/platform details, service settings.
- **Agent configuration (if applicable):** provider, exact model identifier, SDK version, prompts/tool schema hashes, sampling settings, max steps, token budgets.
- **Ground truth:** expected authoritative order/carrier state and explicit success criteria for each case.
- **Actual trace:** state transitions, tool calls, provider responses, exception codes, reconciliation events and timestamps.
- **Outcomes:** evaluator decision, whether a customer-visible claim was made, manual interventions, side-effect counts, latency and token/cost data.
- **Limitations:** known nondeterminism, missing telemetry, changes to fixture/test methodology.

Use machine-readable output where possible: `manifest.json`, `events.jsonl`, `cases.csv`, `summary.json`. Never invent values to complete a table. Use `Not measured` or `Not implemented` instead.

## Test-result truthfulness

Separate these labels in documents and posts:

- **Proposed** — design or test not implemented.
- **Implemented** — code exists, but tests may not have run.
- **Tested** — tests ran and logs are available.
- **Observed** — measured result with repeatable method and sample definition.
- **Production-proven** — **not a claim this simulated study is designed to make**.

A planned “50-case suite” is not “50 passing tests.” A target of zero unauthorized mutations is not a measured rate. Agent tests must use actual model calls to support claims about agent performance.

## README maintenance rule

The README is the public **front door**, not a copy of every design decision. Keep the project's status, problem, architecture overview, exact working commands, supported capabilities, roadmap, evidence links, limitations and source links current. Add `docker compose` / `npm` instructions **only after** they work from a clean checkout. Link to detailed docs rather than repeating them.

## Suggested engineering workflow (per feature)

`Issue / question -> acceptance criteria -> minimal implementation -> tests -> trace/log -> ADR if needed -> update phase report -> update README if public behaviour changes -> commit / PR -> reviewer reruns.`

For research publication, map each significant statement to **code, recorded evidence, independent source, or clearly marked hypothesis**. Diagrams must reflect either *proposed* or *implemented* architecture explicitly.
