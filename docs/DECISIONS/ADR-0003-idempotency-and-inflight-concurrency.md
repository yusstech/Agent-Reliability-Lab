# ADR-0003: Enforce idempotency and one unresolved operation per order in the database

- **Status:** Accepted
- **Date:** 2026-11-02
- **Phase:** 01

## Context
Spec §3: replaying the same idempotency key with the same payload returns the same operation. The same key with a different payload is rejected. Only one in-flight address change is allowed per order. These rules must hold under concurrent requests and across process restarts.

## Options considered
1. **Application-level checks** (`SELECT` and then `INSERT`). Simple, but racy: two concurrent requests can both pass the check.
2. **Application checks under `SELECT … FOR UPDATE` or advisory locks.** Correct when every writer cooperates, but one forgotten code path breaks it.
3. **Database constraints:**
   - `UNIQUE (customer_id, idempotency_key)`.
   - A `request_fingerprint` column (SHA-256 of the canonical payload), so a same-key, different-payload request can be detected after a unique violation.
   - A **partial unique index** on `order_id WHERE status NOT IN ('COMPLETED','REJECTED','NEEDS_MANUAL_REVIEW')`.

## Decision
Option 3. Idempotency keys are scoped per customer, so different customers can never collide. `PENDING_RECONCILIATION` counts as **unresolved**: its side effects are unknown, so a second change must not race it.

## Consequences
- The request path (Phase 03) inserts and maps unique violations. On a key conflict, it compares the stored fingerprint: same payload returns the existing operation, a different payload returns `409`. On an order conflict it returns `409`.
- The list of terminal statuses exists in two places: the SQL index and `TERMINAL_STATUSES` in [operation-state.ts](../../src/domain/operation-state.ts). Test DB-05 checks every status against both, so drift fails CI.
- An operation stuck in `PENDING_RECONCILIATION` blocks new changes to that order until reconciled or escalated. This is intentional.

## Reversal trigger
Revisit if the partial index blocks a legitimate flow, such as a separately authorized recovery that needs a second operation while the first is in manual review, or if fingerprinting rejects requests that differ only in non-semantic fields such as `message`. Whether `message` belongs in the fingerprint is decided in Phase 03. **Resolved:** it is excluded ([ADR-0009 §10](ADR-0009-deterministic-workflow-worker-and-recovery.md)).
