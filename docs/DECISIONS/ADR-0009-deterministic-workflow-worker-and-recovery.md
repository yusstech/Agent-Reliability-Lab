# ADR-0009: Deterministic workflow: worker leases, write-ahead dispatch, version-guarded retries and compensation

- **Status:** Accepted
- **Date:** 2026-11-04
- **Phase:** 03
- **Resolves:** the open items from Phase 01 (compensation state; whether `message` is part of the idempotency fingerprint)

## Context
Variant A must change an address in two independent systems without ever claiming success it hasn't verified, and without applying a write twice. That has to hold across timeouts, crashes, duplicate delivery and concurrent changes ([spec §3](../PROTOTYPE_SPEC.md), invariants I1–I12 in the [Evaluation Plan](../EVALUATION_PLAN.md)). The roadmap asks Phase 03 to decide:
- transaction boundaries;
- claim and lease mechanics;
- how to handle unknown prior side effects;
- what to do on order version conflicts;
- the retry policy when a provider doesn't support idempotency.

Phase 02 showed that `expected_version` blocks duplicate writes even when keys are ignored (traces P02-04 and P02-05), and that a read can be stale right after a successful write (P02-07).

## Decisions

### 1. Transaction boundaries: one provider write per step, logged before dispatch
- **Request path:** the order is read from the order provider *outside* any transaction. Then a single transaction inserts the operation, its events and the confirmation challenge. If the provider read is ambiguous, the API returns `503` and records nothing, so the client can retry safely with the same key.
- **Worker step:** each claimed step makes **at most one provider write**:
  1. Commit a `*_WRITE_DISPATCHED` event recording the provider, idempotency key and expected version. This is write-ahead.
  2. Call the provider with no database transaction open.
  3. Commit the result and any state transition in one transaction.

  A crash between steps 1 and 3 leaves a dispatch with no recorded result. The next owner treats that write as **unknown**.

### 2. Claims and leases: `FOR UPDATE SKIP LOCKED` plus a fencing token
A worker claims the oldest claimable operation with `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1)`, setting a random `lease_token` and an expiry (default 30 s). Every write the worker makes afterwards is conditional on `lease_token` still matching. A worker whose lease expired and was re-claimed finds its updates affect zero rows, stops, and never records a result.
- **Worker-level duplicate delivery** (the spec's `DUPLICATE_DELIVERY`) is two workers or deliveries racing for one operation. It is absorbed by `SKIP LOCKED` and fencing.
- **A provider call from a fenced-out worker** can still land. Decision 4 makes that harmless.

### 3. Every write step reads first
Before writing, the step reads the provider entity:
- **Already at the target address:** the write is skipped. This is how recovery after a crash or timeout avoids re-applying it.
- **Order no longer eligible, or its version moved since validation:** the request is revalidated (I8, against time-of-check/time-of-use changes). If none of our writes has landed, it becomes `REJECTED`.
- **Otherwise:** the write is dispatched with **`expected_version` = the version just read** and a **deterministic idempotency key** `<op>_<provider>_v<version>`.

### 4. At most one application per provider, whatever the provider's idempotency mode
Because every write carries `expected_version`, a repeat of the same logical write is refused (`409`) once the first has landed. This holds after a timeout, a crash, a stale-worker race, or duplication in transit. With honoured keys the repeat is replayed instead. A `409` never ends an operation: it triggers a re-read on the next step.

**Retry policy when the provider ignores idempotency keys** (the roadmap question): retry is allowed, because the version guard rules out duplicates.

### 5. Unknown outcomes go to `PENDING_RECONCILIATION`, resolved in a fixed order
1. **The status-by-key endpoint, where supported.** It is authoritative: `applied` moves to the next state, and `MUTATION_NOT_FOUND` goes back to the write state.
2. **Otherwise, or if the status endpoint is unavailable: read the entity.** If it is at the target, the write was applied.
3. **The read shows the old address:**
   - **Status lookup unsupported:** go back to the write state. The re-read and versioned write are safe even if that read was stale.
   - **Status endpoint unavailable:** the outcome can't be established. Retry with backoff, and after the step budget, **`NEEDS_MANUAL_REVIEW`**. There is no blind retry.

### 6. Compensation gets its own state, `COMPENSATING`
If the carrier definitively refuses after the order was changed, the operation moves `UPDATING_CARRIER → COMPENSATING`.
- **Compensation write:** a version-guarded revert of the order to its original address.
- **Ending as `REJECTED`:** this requires **compensation evidence**: fresh reads showing *both* systems at the original address. `assertTransition` enforces it, so `REJECTED` still can't be reached while a side effect persists.
- **Ending as `NEEDS_MANUAL_REVIEW`:** if the revert is refused, or the order was changed by someone else meanwhile.

*Rejected alternative:* a verified `VERIFYING → REJECTED`. It overloads the meaning of `VERIFYING` and hides compensation from the event history.

### 7. Verification is independent and repeatable
The verifier reads both providers fresh. `COMPLETED` requires both to show the target, and it is the only path to `completed` for the customer (I9, I12). A mismatch is retried with backoff, because the read may be stale (P02-07). A mismatch that persists past the step budget becomes `NEEDS_MANUAL_REVIEW` with reason `VERIFICATION_MISMATCH_UNRESOLVED`.

### 8. A step budget, then escalation
Each state allows `maxStepAttempts` retries (default 5), with backoff `min(base·2ⁿ, cap)`. When the budget runs out, the operation goes to `NEEDS_MANUAL_REVIEW`, never to `REJECTED` and never to "assume it worked".

A definitive rejection is treated as `REJECTED` only when **no earlier write for this operation was dispatched to that provider**. Otherwise it escalates, because a stale read can't prove the earlier write didn't land.

### 9. Consent is a server-issued, single-display token
Creating an operation issues a random 128-bit confirmation token, shown **once** in the `202` response and stored only as a SHA-256 hash with an expiry (default 15 min). `POST /v1/operations/:id/confirm` requires that token from the owning customer. A body flag such as `confirmed: true` is not accepted (I5).
- **Expiry:** an expired challenge moves to `REJECTED (CONFIRMATION_EXPIRED)`. A worker sweep does this, and so does the request path when the expired challenge blocks a new request for the same order.
- **Replays:** replaying the creation request returns the operation without the token.

### 10. The idempotency fingerprint covers `order_id` and `new_address_id`, not `message`
`message` is free text with no effect on execution. Including it would reject harmless retries in which a client re-renders the text. This follows the Stripe caution about hashing request bodies.

### 11. The customer status is derived from the ledger
| Ledger status | Customer status |
| --- | --- |
| `COMPLETED` | `completed` |
| `REJECTED` | `not_changed` |
| `NEEDS_MANUAL_REVIEW` | `needs_review` |
| Anything else | `pending` |

The state machine guarantees `REJECTED` is reachable only when neither system holds our change, so this mapping is truthful by construction. That makes it variant A's I12 enforcement.

## Consequences
- The ledger gains lease, retry and context columns plus a `confirmations` table, and the status lists gain `COMPENSATING` (migration 0003).
- `assertTransition` gains compensation evidence. Callers pass `visited` computed from the event history.
- The order provider gains `GET /orders` (the acting customer's orders). The rule-based intent layer needs it.
- **Manual-review rate is a cost of this design.** Exhausted budgets escalate instead of guessing, which is honest but conservative. Phase 04 measures it.

## Reversal trigger
- If Phase 04 shows manual review dominated by budget exhaustion under transient faults, revisit the budget and backoff. Don't weaken the evidence rules.
- If lease expiry during a long provider call causes repeated fencing, add lease heartbeats.
