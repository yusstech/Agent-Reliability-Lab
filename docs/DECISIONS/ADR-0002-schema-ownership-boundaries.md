# ADR-0002: One Postgres instance, four ownership schemas, no cross-schema foreign keys

- **Status:** Accepted
- **Date:** 2026-11-02
- **Phase:** 01

## Context
The spec requires an order system and a carrier system that are *independent*. They must disagree, time out and fail separately ([spec §2, §9](../PROTOTYPE_SPEC.md)). Phase 02's gate requires "no hidden shared writes between services". Phase 01 still needs a single, simple, testable schema.

## Options considered
1. **One schema with FKs everywhere** (`orders.address_id → saved_addresses`, `operations.order_id → orders`, …). This gives strong referential integrity. But the database would then enforce cross-system consistency, which hides exactly the inconsistencies the experiment must observe. It would also block simulating a carrier record that has drifted.
2. **A separate database per provider now.** This gives true isolation. But it means more infrastructure before any provider logic exists.
3. **One database with separate schemas `identity`, `order_svc`, `carrier_svc` and `ledger`, and FKs only inside a schema.** Ownership is explicit and cheap to set up. Each schema can move to its own service or database in Phase 02 without data-model changes.

## Decision
Option 3 ([migrations/0001_foundation.sql](../../migrations/0001_foundation.sql)). FKs exist only inside `identity` (addresses and sessions → customers) and inside `ledger` (events → operations). Test DB-09 asserts that no cross-schema FK exists.

## Consequences
- Cross-system agreement, such as order and carrier holding the same address, is checked by application code (the future verifier). The database does not enforce it.
- `order_svc.orders.address_id` is not FK-checked against `identity.saved_addresses`. Ownership of the target address must therefore be validated in the request path (Phase 03).
- Phase 02 decides whether schemas become separate services, connection roles or databases.

## Reversal trigger
If Phase 02 finds that schema separation still allows an accidental shared write (for example, one connection writing both provider schemas in a single transaction), split them into separate DB roles or databases.
