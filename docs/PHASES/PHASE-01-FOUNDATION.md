# Phase 01: Project Foundation & Contracts

- **Status:** **Passed** (2026-11-04)
- **Dates:** 2026-11-02 → 2026-11-04
- **Commit at gate:** `c8bae58` on [yusstech/Agent-Reliability-Lab](https://github.com/yusstech/Agent-Reliability-Lab)

## 1. Goal / research value
Give every later variant the same trustworthy ground: a domain model, database constraints that enforce the non-negotiable rules regardless of who writes, a state model that refuses unverified completion, and reproducible fixtures. Without this, any later comparison between A, B and C would also be measuring differences in the scaffolding.

## 2. Scope / non-goals
**In:** TypeScript + Fastify API; PostgreSQL schema + migration runner; domain types; strict request validation; stable error envelope; deterministic fixtures; operation state model; mock server-side identity; health route.

**Out (deliberately):**
- Ownership/eligibility enforcement in the request path, operation creation, confirmation and the worker (Phase 03).
- Separate provider services and fault injection (Phase 02).
- Any model or agent SDK, frontend or live credentials.

`POST /v1/address-change-requests` authenticates and validates, then returns `501 NOT_IMPLEMENTED`. It writes nothing (test API-09).

## 3. Architecture & implementation
| Concern | Code |
| --- | --- |
| Schema (4 ownership schemas) | [migrations/0001_foundation.sql](../../migrations/0001_foundation.sql) |
| Migration runner (ordered, transactional, checksum-guarded, advisory-locked) | [src/db/migrate.ts](../../src/db/migrate.ts) |
| Operation state model | [src/domain/operation-state.ts](../../src/domain/operation-state.ts) |
| Eligibility rule | [src/domain/order-eligibility.ts](../../src/domain/order-eligibility.ts) |
| Request schema + error detail mapping | [src/http/schemas.ts](../../src/http/schemas.ts) |
| Error envelope | [src/http/errors.ts](../../src/http/errors.ts) |
| Mock identity | [src/http/identity.ts](../../src/http/identity.ts) |
| App / routes | [src/app.ts](../../src/app.ts) |
| Deterministic fixtures | [fixtures/generate.ts](../../fixtures/generate.ts), [src/db/seed.ts](../../src/db/seed.ts) |

**State model as implemented.** The spec (§6) lists the states but not every edge, so Phase 01 fixed them:

| From | Allowed next |
| --- | --- |
| RECEIVED | NEEDS_CONFIRMATION, REJECTED |
| NEEDS_CONFIRMATION | QUEUED, REJECTED |
| QUEUED | UPDATING_ORDER, REJECTED |
| UPDATING_ORDER | UPDATING_CARRIER, REJECTED, PENDING_RECONCILIATION, NEEDS_MANUAL_REVIEW |
| UPDATING_CARRIER | VERIFYING, PENDING_RECONCILIATION, NEEDS_MANUAL_REVIEW |
| VERIFYING | COMPLETED (only with dual-system verification evidence), PENDING_RECONCILIATION, NEEDS_MANUAL_REVIEW |
| PENDING_RECONCILIATION | UPDATING_ORDER, UPDATING_CARRIER, VERIFYING, NEEDS_MANUAL_REVIEW |
| COMPLETED, REJECTED, NEEDS_MANUAL_REVIEW | none (terminal) |

Two judgement calls are worth flagging:
- **`REJECTED` is unreachable once the carrier write may have been dispatched (ST-06, ST-06b, ST-06c).** The edge table alone can't guarantee this, because `PENDING_RECONCILIATION → UPDATING_ORDER → REJECTED` is a legal path. So `assertTransition` also takes the operation's `visited` statuses and refuses `REJECTED` (`SIDE_EFFECT_POSSIBLE`) once `UPDATING_CARRIER` has ever been entered. ST-06c searches every reachable path exhaustively. `UPDATING_ORDER → REJECTED` remains allowed only for a *definitive* order rejection where nothing was written. Timeouts go to `PENDING_RECONCILIATION`. Phase 03 must pass `visited` from the ledger's event history.
- **The spec's "compensate, then fail safely" path (§3) has no state yet.** Today a carrier rejection after an order write can only escalate to `NEEDS_MANUAL_REVIEW` or reconcile. Phase 03 must decide, through an ADR, whether to add a `COMPENSATING` state or allow a verified `VERIFYING → REJECTED`. That transition is not pre-approved here.

## 4. Alternatives & trade-offs
- [ADR-0001](../DECISIONS/ADR-0001-compare-three-architectures.md): compare A/B/C rather than assume.
- [ADR-0002](../DECISIONS/ADR-0002-schema-ownership-boundaries.md): one DB, four schemas, no cross-schema FKs.
- [ADR-0003](../DECISIONS/ADR-0003-idempotency-and-inflight-concurrency.md): idempotency and in-flight blocking enforced by DB constraints.
- [ADR-0004](../DECISIONS/ADR-0004-mock-identity-isolation.md): hashed mock sessions; identity isolated from business code.
- [ADR-0005](../DECISIONS/ADR-0005-api-error-envelope.md): single envelope with closed code vocabulary.

Runtime choice, no ADR: Node ≥ 22.18 runs `.ts` directly through built-in type stripping, so there is no build step or `tsx` loader. The code is limited to erasable TypeScript syntax (`erasableSyntaxOnly`).

## 5. Reliability & security concerns
- **Identity spoofing:** body `customer_id` and `confirmed` are rejected. Identity comes only from the session table (VA-03, API-06).
- **Token handling:** stored as SHA-256 (SD-02); `authorization` is redacted from logs. Verified manually: zero occurrences of the token in the server log after authenticated curl calls.
- **Evidence integrity:** `ledger.operation_events` is append-only through a trigger (DB-07). `TRUNCATE`, used only by the dev seeder, bypasses it by design.
- **Destructive tooling:** the API, seed and reset refuse `NODE_ENV=production`. The test suite refuses any database whose name doesn't end in `_test`.
- **Concurrency:** duplicate keys and overlapping unresolved operations are rejected by the database itself, not by racy app checks (DB-02…05).

## 6. Validation
**Environment (recorded 2026-11-02):** macOS (Darwin 25.6.0, arm64), Node v26.8.1, npm 11.19.0, Docker 29.6.2, Compose v5.3.1, PostgreSQL 16.14 (`postgres:16-alpine`), fastify 5.12.8, pg 8.23.1, zod 4.6.7, TypeScript 7.0.2, Vitest 5.1.0.

**Clean-start procedure (executed):**
```
npm run db:down && npm run db:up
npm run migrate   # migrations applied: 0001_foundation; already applied: (none)
npm run seed      # seeded base-v1 seed=1042 digest=95661cd2…9508 customers=8 addresses=19 orders=24 shipments=24
npm run typecheck # exit 0, no output
npm test          # Test Files 8 passed (8) · Tests 50 passed (50)
```

**Clean-checkout verification (2026-11-04, gate checklist item 1):** a fresh `git clone` of `c8bae58` into `/tmp` (APFS, not the exFAT development volume), then `cp .env.example .env`, `npm ci`, `npm run typecheck` (exit 0) and `npm test` → 8 files, 50 tests passed. That run used the already-running local Postgres container, not its own `db:up`.

**Test inventory → acceptance criteria:**
| Done-when criterion | Tests | Result |
| --- | --- | --- |
| API starts locally | API-01, plus manual `npm start` + `curl /health` → `200 {"status":"ok","database":"ok","schema_version":"0001_foundation"}` | Pass |
| Schema checks pass from a clean DB | DB-01…DB-09 (incl. DB-08b) (global setup drops and re-migrates from zero) | Pass |
| Fixture determinism | FX-01…FX-04, SD-01, SD-02, CF-03 | Pass |
| Invalid requests return stable errors | VA-01…VA-06, API-02b, API-04…API-10 | Pass |
| Operation state rules unit-tested | ST-01…ST-10 (incl. ST-06b/c), EL-01 | Pass |
| No live data or external writes | All data synthetic; the only network target is local Postgres; API-09 confirms no ledger write | Pass |

**Observed during the phase:** these are failures found and fixed, not hidden.
1. Docker Desktop could not bind-mount an init script from the external exFAT volume (`mkdir /host_mnt/Volumes/exteralD: operation not permitted`). Fix: the test helper creates `arl_test` itself, so nothing is mounted.
2. Vitest collected macOS AppleDouble `._*.test.ts` files, which exFAT creates, and failed to parse them. Fix: excluded `**/._*`.
3. API-08 initially failed: `text/plain` returned 400, not 415, because Fastify registers a default text parser. Fix: the parser is removed, so the API is JSON-only (ADR-0005).

**Code review (2026-11-02).** (AI-assisted review with Claude, which I checked and added to.) A full review of `src`, `fixtures`, `scripts`, `tests` and `migrations` found 10 issues. All were confirmed and fixed, each with a regression test where one could be written:

| # | Issue | Fix | Test |
| --- | --- | --- | --- |
| 1 | `REJECTED` reachable after a carrier dispatch via reconciliation → order retry | `visited` history check in `assertTransition` | ST-06b, ST-06c |
| 2 | `seed`/`db:reset` guarded only by `NODE_ENV === 'production'` | `assertLocalDatabase` allow-list (localhost/127.0.0.1/::1), also applied to the test suite | CF-01; manual: remote host refused |
| 3 | Unlisted framework 4xx errors became `500 INTERNAL` | Keep status, code `BAD_REQUEST` | API-08 (bad content-length) |
| 4 | Body was parsed before auth, so unauthenticated callers saw 400/413/415 | Auth moved to a `/v1` `onRequest` hook | API-05 |
| 5 | Session-store outage returned `500` rather than `503` | Map lookup failure to `DEPENDENCY_UNAVAILABLE` | API-02b |
| 6 | A second shutdown signal threw; a failed close hung the process | Idempotent shutdown with exit code on failure | Manual: SIGINT+SIGTERM → one shutdown, clean exit |
| 7 | Event `from_status`/`to_status` accepted any text in an append-only log | CHECK constraints (edited `0001` in place, since nothing has been committed) | DB-08b |
| 8 | API imported `hashToken` from fixture code | Moved to `src/security/token-hash.ts` | Existing SD-02, API-03 |
| 9 | `Bearer` scheme matched case-sensitively | Case-insensitive scheme, case-sensitive token | API-05b |
| 10 | Seed parsing and the reset sequence were duplicated | `fixtureSeedFromEnv`, `resetDatabase`; seed must be decimal | CF-03 |

## 7. Limitations
- Order and carrier are separate schemas but not yet separate processes. Independence is structural only until Phase 02.
- The carrier stores `address_id`, not an address snapshot, matching spec §8. A real carrier holds its own copy of the address text, so "address drift" can't be modelled yet. Revisit in Phase 02.
- The DB checks status *values*, not *transitions*. Transitions are enforced in the domain layer only, and Phase 03 must route every status write through `assertTransition`.
- The fixture is a base dataset (8 customers / 24 orders). The 50-case scenario dataset is Phase 04.
- Tests share one database and run serially (`fileParallelism: false`).
- On exFAT volumes npm can't create `node_modules/.bin` symlinks, so `.npmrc` sets `bin-links=false` and scripts call tools by path.

## 8. Outcome / next decision
All Phase 01 done-when criteria passed, and the gate is **signed off as Passed** at `c8bae58`. During the phase, the study design was revised to spec v0.3 ([ADR-0006](../DECISIONS/ADR-0006-enforcement-ladder-and-preregistration.md), [ADR-0007](../DECISIONS/ADR-0007-models-harness-and-budget.md)). **Next:** Phase 02 decides how the order and carrier providers become independent services, and how fault modes are injected deterministically, with an ADR on the timeout-after-write simulation. Open items carried forward: the compensation state (§3 above) and whether `message` is part of the idempotency fingerprint (ADR-0003).
