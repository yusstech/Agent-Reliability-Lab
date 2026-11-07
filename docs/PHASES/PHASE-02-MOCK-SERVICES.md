# Phase 02: Independent Mock Providers & Fault Injection

- **Status:** **Passed** (2026-11-04)
- **Dates:** 2026-11-04 → 2026-11-04
- **Commit at gate:** `1161eaa` (merge of [PR #1](https://github.com/yusstech/Agent-Reliability-Lab/pull/1)). The merged `main` was re-verified from an empty database: 12 files, 78 tests passed.

## 1. Goal / research value
Every later claim about recovery depends on one capability: injecting a provider failure on demand, identically every time, and then knowing *for certain* what the provider did. In particular, the study must be able to produce two situations that look **identical to the caller** but differ in reality: a timeout before the write and a timeout after it. If it can't, "unknown outcome" can't be measured.

## 2. Scope / non-goals
**In:**
- independent order and carrier services, each with its own pool and DB role;
- versioned, append-only mutation logs;
- per-provider idempotency modes;
- status-by-key endpoints;
- all eight spec fault modes;
- a scenario control surface;
- a provider client that classifies every outcome;
- 12 named scenarios with golden traces.

**Out:**
- the orchestrator, ledger writes, retry policy and reconciliation (Phase 03);
- worker-level duplicate delivery (Phase 03; see ADR-0008 §7);
- held-out faults (sampled after the freeze; see the Evaluation Plan §3.2).

## 3. Architecture & implementation

| Concern | Code |
| --- | --- |
| Role-scoped pools | [src/providers/pools.ts](../../src/providers/pools.ts), [migrations/0002_provider_services.sql](../../migrations/0002_provider_services.sql) |
| Fault engine (count-based, no clock) | [src/providers/faults.ts](../../src/providers/faults.ts) |
| Shared write path (versioned, idempotent, logged) | [src/providers/address-change.ts](../../src/providers/address-change.ts) |
| Generic provider with fault hooks | [src/providers/provider.ts](../../src/providers/provider.ts) |
| Order / carrier definitions | [order-service.ts](../../src/providers/order-service.ts), [carrier-service.ts](../../src/providers/carrier-service.ts) |
| Outcome-classifying client | [src/providers/client.ts](../../src/providers/client.ts) |
| Scenario catalog / trace runner | [scenarios/provider-faults.ts](../../scenarios/provider-faults.ts), [src/providers/trace.ts](../../src/providers/trace.ts) |
| Generated evidence | [evidence/phase-02-fault-traces.md](evidence/phase-02-fault-traces.md) ([JSON](evidence/phase-02-fault-traces.json)) |

### Provider API
The order service requires `x-acting-customer-id` and returns 404 for orders the customer doesn't own. The carrier service has no customer identity.

| Method & path | Success | Definitive refusals | Ambiguous (fault-driven) |
| --- | --- | --- | --- |
| `GET /orders/:id`, `GET /shipments/:ref` | `200 {order}` / `{shipment}` | `404 NOT_FOUND`, `400 MISSING_ACTING_CUSTOMER` | timeout, `503` |
| `POST …/address-changes` `{address_id, idempotency_key?, expected_version?}` | `200 {mutation, entity}`, with `idempotent-replayed: true` on replay | `409 VERSION_CONFLICT`, `409 IDEMPOTENCY_KEY_REUSED`, `422 SHIPMENT_DISPATCHED` (carrier), `422 PROVIDER_REJECTED` | timeout or reset, before or after commit |
| `GET …/address-changes/:key` | `200 {applied: true, mutation}` | `404 MUTATION_NOT_FOUND`, `501 NOT_SUPPORTED` (keys ignored) | timeout, `503` |
| `PUT /_dev/scenario`, `DELETE /_dev/scenario`, `GET /_dev/state` | Scenario control (local only) | `400 VALIDATION_FAILED` | — |

Example from a separate-process run on 2026-11-04 (request ID elided):

```sh
$ curl -s -X PUT localhost:3102/_dev/scenario -H 'content-type: application/json' \
    -d '{"scenario_id":"demo","rules":[{"fault":"PERMANENT_REJECTION","target":"*"}]}'
{"provider":"carrier","scenario_id":"demo","honour_idempotency_keys":true,"rules":[{"fault":"PERMANENT_REJECTION","target":"*","on":"mutation","after":0,"times":1,"params":{"manifest":"hang","hang_ms":1000,"stale_reads":2},"matched":0,"fired":0}]}
$ curl -s -X POST localhost:3102/shipments/shp_0001/address-changes -H 'content-type: application/json' -d '{"address_id":"addr_001"}'
{"error":{"code":"PROVIDER_REJECTED","message":"provider rejected the change","request_id":"…"}}
```

## 4. Alternatives & trade-offs
[ADR-0008](../DECISIONS/ADR-0008-provider-simulation-and-fault-model.md) answers the four roadmap questions:
- **Where the truth about a timed-out write lives:** in the provider's own mutation log, committed in the same transaction as the write.
- **Key scope:** per provider. Keys can be honoured or ignored per scenario.
- **Eventual consistency:** counted in reads, with no timing involved.
- **Clock:** none in fault logic.

It also records the rejected options: separate databases, convention-only isolation, and time-based staleness.

## 5. Reliability & security concerns
- **Isolation is enforced.** Each provider's role can't read or write another schema (PV-01). The role applies to every pooled connection (PV-02), and the mutation logs are append-only for the services (PV-03).
  - *Found during the phase:* the first implementation ran `SET ROLE` in the pool's `connect` handler. pg 8.23 warned that this races with the first query, so a connection could have run without the role. It was fixed by setting the role as a connection startup parameter (`options: -c role=…`), and PV-02 now checks it.
- **The order service hides other customers' orders** as 404, not 403 (PB-01). The acting-customer header is *trusted*: whoever calls the provider asserts it. Phase 05 tools must set it from the server session, never from model output (ADR-0004).
- **The control surface is local-only.** Routes exist only when enabled (PV-05), and the provider servers refuse `NODE_ENV=production`.

## 6. Validation
**Environment:** same as Phase 01 (Node v26.8.1, PostgreSQL 16.14, macOS arm64).

```
npm run db:down && npm run db:up && npm run migrate && npm run seed
npm run typecheck   # exit 0
npm test            # 12 files, 78 tests passed
npm run traces      # wrote 12 scenario traces to docs/PHASES/evidence/
```

| Done-when criterion | Evidence | Result |
| --- | --- | --- |
| Each fault triggers deterministically from a named scenario | 12 scenarios covering all 8 modes (TR-01). Regenerating them reproduces the committed trace JSON exactly (TR-02). A deliberate one-parameter change makes TR-02 fail, so the golden check has teeth. | Pass |
| Assertions prove the expected provider state | FD-01…03, PB-04…06, plus the before/after state and mutation counts in every trace | Pass |
| Timeout-before-write is distinguishable from timeout-after-write | **FD-01:** an identical client outcome `{kind: unknown, reason: timeout}`, but address v1 vs v2, 0 vs 1 mutations, and `MUTATION_NOT_FOUND` vs `applied` | Pass |
| No hidden shared writes between services | PV-01 (permissions), PV-04 (an order write leaves carrier rows byte-identical) | Pass |

**What the traces show** ([summary](evidence/phase-02-fault-traces.md)). These are observations of *provider behaviour* under a fixed probe, not experimental results:
- **P02-04 vs P02-05:** with idempotency keys ignored, a blind retry after timeout-after-write **duplicates the side effect** (2 mutations, v3). The same retry sent with `expected_version` is refused (`409`), leaving exactly 1 mutation. Optimistic concurrency guards against duplicates even without idempotency support.
- **P02-07:** the write succeeds, the next read returns the old address, and the one after returns the new address. A verifier that reads once can be fooled.
- **P02-08:** a read-then-write with `expected_version` catches the concurrent shipment (`409`). The carrier refuses its write (`422 SHIPMENT_DISPATCHED`).
- **P02-11:** the write happened and the status endpoint is down. Only the honoured-key replay makes the retry safe.

**Code review of PR #1 (2026-11-04).** (AI-assisted review with Claude, which I checked and added to.) It found 10 issues. 9 were confirmed and fixed; for the 10th, the classification stays and the contract was made explicit.

| # | Issue | Resolution | Test |
| --- | --- | --- | --- |
| 1–2 | Fault rules fired before the existence and ownership check, so a fault could answer for a missing or not-owned order (leaking existence) and spend its trigger budget | Entity resolved first on every route | PB-08 (fails on the pre-fix code) |
| 3 | Claim that 408/429 should be UNKNOWN | Not a bug: a 4xx means *this* request was not applied. The client contract now states that retryability is decided by `code` | CL-01 |
| 4 | A timeout while reading a 2xx body was reported as `server_error` | Reported as `timeout` | CL-02 (fails on the pre-fix code) |
| 5 | Provider ports were not validated (`''` gave a random port) | Shared `parsePort` | CF-04 |
| 6 | Hung-socket bookkeeping outlived closed sockets | Cleared on socket `close` | Not unit-testable; covered by close-time cleanup |
| 7 | The probe silently dropped `expected_version` when its read failed | The probe refuses to run | PB-09 |
| 8 | `GRANT role TO CURRENT_USER` could fail on a cluster where another user created the roles | Granted only when membership is missing (migration edited in place, since it is unmerged) | Clean-room migrate |
| 9–10 | Duplicated id/key patterns and copy-pasted trace code | `src/providers/ids.ts`; helpers | Existing tests and TR-02 |

## 7. Limitations
- **Isolation is a guard, not a security boundary.** The connecting user can `RESET ROLE`. The trace observer reads both schemas as the application user by design: it is the experiment's view of reality.
- **Hangs use real timers.** Tests keep at least a 10× margin (client 100–200 ms against hang 1–2 s). This has not been tested on a heavily loaded machine.
- **`CONCURRENT_STATUS_CHANGE` is configured on each provider separately.** The world can end up inconsistent (order `SHIPPED`, shipment still `AWAITING_PICKUP`) if the caller never reaches the carrier.
- **The status endpoint is never stale**, even under `SLOW_CONSISTENCY`.
- **Mutation logs record only successful writes.** A rejected request with a key is re-evaluated on retry rather than replayed (an ADR-0008 deviation from Stripe). A replay returns the original mutation with the *current* entity.
- **The carrier still stores `address_id`, not an address snapshot** (carried over from Phase 01), so address-normalisation drift can't be simulated yet. It is a candidate held-out fault.
- **Providers run in-process for tests and traces**, and as separate processes only for manual runs. There is no automated multi-process test.

## 8. Outcome / next decision
All done-when criteria pass, and the gate is **signed off as Passed** at `1161eaa`. **Next, Phase 03:** the deterministic baseline (variant A). That covers the confirmation challenge, the operation ledger and worker with lease and recovery, and adapters built on `ProviderClient`. A verifier must read more than once, or use the status endpoint, because of P02-07. Reconciliation must branch on idempotency mode, because of P02-04 and P02-05. The rule-based intent layer and worker-level duplicate delivery are also needed.

**What changed in our thinking:** `expected_version` turned out to be the cheapest strong guard against duplicates, working even where providers lack idempotency. Phase 03 should always send it, and the B-ladder tool design should decide at which rung the tools send it automatically.
