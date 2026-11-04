# ADR-0008: Provider simulation, fault model and idempotency modes

- **Status:** Accepted
- **Date:** 2026-11-04
- **Phase:** 02

## Context
Phase 02 must make provider failures **controllable and reproducible** ([roadmap](../IMPLEMENTATION_ROADMAP.md)). The roadmap asks four questions to answer before building:
1. How does the simulated provider know whether a timed-out write happened?
2. How are idempotency keys scoped?
3. How is eventual consistency modelled?
4. How is time controlled in tests?

The [Evaluation Plan](../EVALUATION_PLAN.md) adds three requirements:
- a per-provider switch for honouring idempotency keys;
- a fault interface broad enough for faults sampled later from an external taxonomy;
- independence strong enough that "no hidden shared writes" is enforced, not just intended ([ADR-0002](ADR-0002-schema-ownership-boundaries.md) reversal trigger).

## Decisions

### 1. Independence is enforced by database roles
Each provider is its own Fastify service with its own connection pool. Every connection runs `SET ROLE` to a provider role (`arl_order_svc`, `arl_carrier_svc`). That role has privileges **only** on its own schema: `SELECT/INSERT/UPDATE` on the entity table, and `SELECT/INSERT` only on its mutation log, which makes the log append-only for the service. A cross-schema write fails with `permission denied`, and a test proves it.

*Rejected alternatives:*
- **Separate databases:** more infrastructure for no extra research value.
- **Convention only:** not provable.

*Limitation:* the connecting user can `RESET ROLE`. This guards against accidental cross-writes in our own code, not against malicious code.

### 2. The provider is the ground truth for whether a write happened
Every applied mutation is committed to the provider's own **mutation log** (`<schema>.address_mutations`) in the same transaction as the entity update. Timeout faults decide *when the response fails* relative to that commit:
- **`TIMEOUT_BEFORE_WRITE`:** the request is received but not applied, then the response hangs or the connection resets.
- **`TIMEOUT_AFTER_WRITE`:** the mutation **commits**, then the response hangs or resets.

The client sees the same thing in both cases: an ambiguous outcome. They can be told apart only through the provider's state, by reading the entity or querying the mutation status. That is the property the study depends on.

**How a timeout shows up** (`params.manifest`):
- `hang` (default): the connection is held open for `hang_ms`, then destroyed. The client's own timeout fires first.
- `reset`: the socket is destroyed immediately. The client sees a connection error.

### 3. Idempotency keys are provider-scoped, with two modes
Keys are scoped **per provider**. Each provider has one merchant here, so this matches Stripe's per-account scoping. The mode is set per scenario:
- **Honoured:** a key with an identical payload fingerprint (entity, address, expected version) replays the stored response with `idempotent-replayed: true` and writes nothing. The same key with a different payload returns `409 IDEMPOTENCY_KEY_REUSED`. Key handling is serialised with an advisory lock. The status endpoint `GET …/address-changes/:key` answers authoritatively: `200 applied` or `404 MUTATION_NOT_FOUND`.
- **Not honoured:** keys are recorded but ignored, so every request applies. The status endpoint returns `501 NOT_SUPPORTED`. Reconciliation must then fall back to reading the entity.

*Deviation from Stripe:* only **successful** mutations are recorded. A rejected request (version conflict, dispatched shipment) is re-evaluated on retry instead of having its error replayed. This keeps the log equal to "side effects that happened".

**Optimistic concurrency is independent of idempotency.** A request carrying `expected_version` can't apply twice even in the not-honoured mode, because the second attempt gets `409 VERSION_CONFLICT`. We expect this to matter in the results, so it is recorded here as a design fact.

### 4. Eventual consistency is counted in reads, not measured in time
`SLOW_CONSISTENCY` commits the write and responds `200`. The next `stale_reads` entity reads (default 2) then return the **pre-write snapshot**. The status endpoint stays authoritative, because providers usually expose a strongly consistent write-path lookup separately from read replicas.

### 5. No wall clock in fault logic
Every trigger is **count-based**: a rule fires on the n-th matching operation (`after`), for `times` occurrences. There is no randomness inside providers. The scenario seed selects the fixture only. The only real time involved is hang duration, and tests keep a ≥10× margin between client timeout and hang. Same scenario and same request sequence give the same provider state and the same trace, which is checked against a committed golden file.

### 6. Business guards stay where real systems put them
- **Order service:** checks the **acting customer** (`x-acting-customer-id`, set by the caller's trusted layer). An order the customer doesn't own returns `404`, so existence isn't leaked. It does **not** check order status, because eligibility (I4) is application policy, matching the enforcement matrix.
- **Carrier:** merchant-trusted, with no customer identity. It refuses changes to shipments that aren't `AWAITING_PICKUP` (`422 SHIPMENT_DISPATCHED`). That is the spec's natural permanent rejection.

### 7. Fault modes and where they apply

| Fault | Operations | Effect |
| --- | --- | --- |
| `TIMEOUT_BEFORE_WRITE` | mutation, read, status query | No write; hang or reset |
| `TIMEOUT_AFTER_WRITE` | mutation | Commit, then hang or reset |
| `PERMANENT_REJECTION` | mutation | `422 PROVIDER_REJECTED`; no write |
| `SLOW_CONSISTENCY` | mutation | Commit and `200`; next *k* reads are stale |
| `CONCURRENT_STATUS_CHANGE` | order: after a read; carrier: before a mutation | Order becomes `SHIPPED` (version +1); shipment becomes `IN_TRANSIT` (version +1). This is a world change, not a client mutation |
| `DUPLICATE_DELIVERY` | mutation | The request is processed twice, as if duplicated in transit |
| `UNAVAILABLE_STATUS_QUERY` | status query, read | `503 SERVICE_UNAVAILABLE` |

**Faults act only on requests the caller was entitled to make.** Every route resolves the entity, checking existence and actor visibility, before any rule fires. A missing or not-owned entity is a plain `404`, and it consumes no fault budget.

`NORMAL` means no rules. Rules combine: for example, `TIMEOUT_AFTER_WRITE` together with `UNAVAILABLE_STATUS_QUERY` models "the write happened and we can't find out".

**Two levels of duplicate delivery.** The provider-level fault above duplicates a request *in transit*. The spec's worker-level fault, the same job delivered twice to the worker, belongs to the orchestrator and is built in Phase 03.

**Extensibility.** A fault is a named rule with a hook point (read, mutation or status query), a target, counters and parameters. Faults sampled later for R-hold (wrong-entity writes, address normalisation drift, schema drift) are new rule types on the same hooks. The engine doesn't need to change.

### 8. The scenario control surface is local-only
`PUT /_dev/scenario` and `GET /_dev/state` are registered only when dev routes are enabled. Provider servers refuse to start with `NODE_ENV=production` (spec §7).

## Consequences
- Phase 03 adapters must treat timeouts, connection errors and 5xx after a mutation as **unknown**, never as failure. The one exception is `501`, which is a permanent statement about the API. `rejected` promises only that *this* request was not applied, not that retrying is pointless: callers branch on `code`. The shared provider client (`src/providers/client.ts`) encodes this classification.
- **`CONCURRENT_STATUS_CHANGE` is configured on each provider separately,** because there is no cross-service coordinator. If the caller never reaches the carrier, the order can end `SHIPPED` while the shipment is still `AWAITING_PICKUP`. Ground truth for each case records this.
- Golden traces make any accidental change in provider behaviour fail CI.

## Reversal trigger
- If Phase 04 needs a fault that depends on elapsed time, such as a lease expiring during a slow write, introduce an injectable clock rather than real sleeps.
- If role separation proves too weak in practice, move providers to separate databases.
