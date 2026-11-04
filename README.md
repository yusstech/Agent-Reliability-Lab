# Agent Reliability Lab (ARL)

**Making AI-powered business operations verifiable, recoverable, and measurable.**

Part of *The Product Systems Notebook*, **Investigation 001: The Agent Said "Done." The Order Wasn't Updated.**

> **Status: Phases 01 and 02 have passed their gates; Phase 03 (variant A, the deterministic baseline) is tested** ([01](docs/PHASES/PHASE-01-FOUNDATION.md), [02](docs/PHASES/PHASE-02-MOCK-SERVICES.md), [03](docs/PHASES/PHASE-03-DETERMINISTIC.md)). 116 automated tests pass from a clean database. There is **no** evaluation harness, model integration or experimental result yet. Nothing here is a measured finding.

## The question

When a customer asks an AI assistant to change a delivery address, what does it take to *know* the change actually happened? That matters most when an API times out, a shipment changes status, or two systems disagree.

The study is organised around one question: **for each business rule, does stating it to the model work as well as enforcing it in code?** We compare variants on the same simulated services and fault scenarios:

| Variant | Execution design | What we want to learn |
| --- | --- | --- |
| A. Deterministic | Software controls each step; no model controls execution. | How far a conventional workflow gets. |
| B0–B3. Agent-directed ladder | A model sequences tools. Every rung gets the *same full written policy*; each rung moves more of the rules from the prompt into code. | Which rules a model can be trusted to follow, and which must be enforced. |
| C. Hybrid (Action-Selector) | A model proposes one typed action; deterministic policy, workflow and verification control mutation and what the customer is told. | Whether language flexibility comes without execution risk. |

The primary metric is **claim accuracy**: whether what the customer was told matches the verified state of both systems. It counts false success *and* false failure. Hypotheses are pre-registered in the [Evaluation Plan](docs/EVALUATION_PLAN.md). No winner is assumed, and the maintainer's prior is written down so it can be shown wrong. Prior work and what this study adds: [Related Work](docs/RELATED_WORK.md). **Invariant:** `COMPLETED` requires fresh authoritative reads showing the target address in *both* the order and carrier systems. A tool's "success" message is not enough.

## What exists today

| Capability | Status | Evidence |
| --- | --- | --- |
| Postgres schema: `identity`, `order_svc`, `carrier_svc`, `ledger`, with idempotency and one-unresolved-operation-per-order constraints | Tested | DB-01…09 |
| Operation state model that refuses unverified completion | Tested | ST-01…10 |
| Deterministic seeded fixtures (8 customers, 19 addresses, 24 orders/shipments) | Tested | FX-01…04, SD-01…02 |
| Mock server-side identity (hashed session tokens) | Tested | API-03…06 |
| Strict request validation with a stable error envelope | Tested | VA-01…06, API-07…10 |
| `GET /health` | Tested | API-01…02 |
| Variant A end to end: request validation, one-time consent token, durable ledger, leased and fenced worker, reconciliation, compensation, independent verifier, truthful customer status | Tested | RQ-01…10, CF-01…04, WK-01…14, [10 golden workflow traces](docs/PHASES/evidence/phase-03-workflow-traces.md) |
| Rule-based intent layer (variant A's language baseline) | Tested (unit) | IN-01…06 |
| Independent order and carrier services: separate DB roles, append-only mutation logs, idempotency on or off, all 8 spec fault modes | Tested | PV-01…05, PB-01…07, FD-01…03, [12 golden fault traces](docs/PHASES/evidence/phase-02-fault-traces.md) |
| 50-case evaluation, metrics, results | Not implemented (Phase 04) | — |
| Agent-directed / hybrid variants | Not implemented (Phase 05) | — |

Full record, including problems found along the way: [Phase 01 report](docs/PHASES/PHASE-01-FOUNDATION.md).

## Run it

**Prerequisites:** Node ≥ 22.18 (verified on v26.8.1; `.ts` files run directly via Node's type stripping), npm, and Docker with Compose.

```sh
cp .env.example .env     # local-only throwaway credentials
npm install
npm run db:up            # Postgres 16 on 127.0.0.1:54329
npm run migrate          # → migrations applied: 0001_foundation
npm run seed             # → seeded base-v1 seed=1042 digest=95661cd2…
npm run typecheck
npm test                 # → Tests 116 passed (116); resets its own arl_test database
npm run traces           # regenerates the Phase 02 fault-trace evidence
npm run traces:workflow  # regenerates the Phase 03 workflow-trace evidence
npm start                # API on http://127.0.0.1:3000
npm run start:order      # mock order service on :3101 (separate process)
npm run start:carrier    # mock carrier service on :3102
npm run start:worker     # variant A worker (separate process)
```

Example responses (captured 2026-11-02; request IDs vary):

```sh
$ curl -s localhost:3000/health
{"status":"ok","database":"ok","schema_version":"0001_foundation"}

$ curl -s localhost:3000/v1/session -H 'Authorization: Bearer mock_session_cus_001'
{"customer_id":"cus_001","auth_mode":"mock_session"}

$ curl -s -X POST localhost:3000/v1/address-change-requests \
    -H 'Authorization: Bearer mock_session_cus_001' -H 'content-type: application/json' \
    -d '{"order_id":"ord_1001","new_address_id":"addr_002","idempotency_key":"req_73a8","customer_id":"cus_002"}'
{"error":{"code":"VALIDATION_FAILED","message":"request body is invalid","request_id":"…","details":[{"path":"customer_id","issue":"unrecognized_key","message":"field is not accepted"}]}}
```

An end-to-end address change through variant A, with the API, both providers and the worker running as separate processes. Captured 2026-11-04; IDs and timestamps vary, and some fields are elided:

```sh
$ curl -s -X POST localhost:3000/v1/address-change-requests -H 'Authorization: Bearer mock_session_cus_001' \
    -H 'content-type: application/json' \
    -d '{"order_id":"ord_1001","new_address_id":"addr_001","message":"Please send my order to my home address","idempotency_key":"req_demo_0001"}'
{"operation_id":"op_5f1e…","status":"NEEDS_CONFIRMATION","customer_status":"pending",…,"summary":"Change ord_1001 to saved address addr_001","confirmation":{"token":"xfU4…","expires_at":"…"}}

$ curl -s -X POST localhost:3000/v1/operations/op_5f1e…/confirm -H 'Authorization: Bearer mock_session_cus_001' \
    -H 'content-type: application/json' -d '{"confirmation_token":"xfU4…"}'
{"operation_id":"op_5f1e…","status":"QUEUED","customer_status":"pending",…,"reason":"CONFIRMED_BY_CUSTOMER",…}

$ curl -s localhost:3000/v1/operations/op_5f1e… -H 'Authorization: Bearer mock_session_cus_001'
{"operation_id":"op_5f1e…","status":"COMPLETED","customer_status":"completed",…,"reason":"VERIFIED_BOTH_SYSTEMS",…,"verified":{"order_address_id":"addr_001","carrier_address_id":"addr_001"}}

$ curl -s -X POST localhost:3000/v1/operations/op_5f1e…/confirm -H 'Authorization: Bearer mock_session_cus_002' …
{"error":{"code":"OPERATION_NOT_FOUND","message":"operation not found","request_id":"…"}}
```

Fixture session tokens are `mock_session_cus_001` … `mock_session_cus_008`. They are synthetic and only work against the local database. `npm run db:reset` drops, migrates and reseeds `arl_dev`. It, and `seed`, refuse any database host other than localhost. `npm run db:down` removes the container and its data.

## Repository map

- [docs/PROTOTYPE_SPEC.md](docs/PROTOTYPE_SPEC.md): domain rules, contracts, state model, target architecture
- [docs/EVALUATION_PLAN.md](docs/EVALUATION_PLAN.md): invariants, variants, pre-registered hypotheses, datasets, metrics, statistics
- [docs/RELATED_WORK.md](docs/RELATED_WORK.md): prior work and positioning
- [docs/IMPLEMENTATION_ROADMAP.md](docs/IMPLEMENTATION_ROADMAP.md): phases, gates, progress
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): implemented components and trust boundaries
- [docs/DECISIONS/](docs/DECISIONS/): ADR-0001…0009
- [docs/DOCUMENTATION_STANDARD.md](docs/DOCUMENTATION_STANDARD.md): evidence and writing rules; [docs/TEMPLATES/](docs/TEMPLATES/)
- `migrations/`, `src/`, `fixtures/`, `scripts/`, `tests/`: implementation

## Research transparency

- All services and data are simulated; no real customer data or credentials are involved.
- The diagrams in the spec are *proposed* unless [ARCHITECTURE.md](docs/ARCHITECTURE.md) marks them implemented.
- A fabricated model response is not evidence of agent reliability. Agent results will come only from real, logged model calls. These are planned with Claude Haiku 5.5 and Claude Sonnet 5.5, so the findings apply to those models and this harness, not to agents in general.
- This is a research artifact, not production security guidance.

## References

- AWS Builders' Library: [Making retries safe with idempotent APIs](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/)
- OpenAI: [Agents SDK](https://developers.openai.com/api/docs/guides/agents/sdk) · [Guardrails and human review](https://developers.openai.com/api/docs/guides/agents/guardrails-approvals)

*Maintainer: Yusuf Muhammed · Series: The Product Systems Notebook · Study: Investigation 001*
