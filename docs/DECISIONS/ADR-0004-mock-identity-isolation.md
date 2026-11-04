# ADR-0004: Mock identity via hashed server-side session tokens, isolated from business logic

- **Status:** Accepted
- **Date:** 2026-11-02
- **Phase:** 01

## Context
Spec §3: identity comes from a server-owned session, and model output can never assert it. Building production authentication is out of scope ([roadmap, scope control](../IMPLEMENTATION_ROADMAP.md)). We still need identity to behave as it would in production, so that variants B and C can't bypass it.

## Options considered
1. **`X-Customer-Id` header.** Trivial, but it trains the codebase to trust caller-supplied identity, which is the exact failure we study.
2. **Real auth (OIDC/JWT).** Realistic, but out of scope and adds no research value.
3. **Opaque bearer tokens mapped to a customer in `identity.mock_sessions`, stored as SHA-256 hashes.** One resolver (`resolveIdentity` in [identity.ts](../../src/http/identity.ts)) is the only code that establishes identity.

## Decision
Option 3. Additional rules:
- Request bodies are strict. `customer_id`, `confirmed` and any other unknown field are rejected with `VALIDATION_FAILED`, never silently ignored (tests VA-03, API-06).
- Missing, malformed and unknown tokens all produce the same `401` (API-04).
- Authentication runs in an `onRequest` hook for every `/v1` route, before the body is parsed or validated. Unauthenticated callers get 401 whatever the body, content type or size, so they learn nothing about the schema (API-05).
- A session-store outage returns `503 DEPENDENCY_UNAVAILABLE`, never 401 or 500 (API-02b).
- The `authorization` header is redacted from logs. The API, seed and reset scripts refuse to start with `NODE_ENV=production`.

## Consequences
- Fixture tokens (`mock_session_cus_001`, …) are deterministic and public by design. They grant access only to synthetic data on a local database.
- Business code receives an `Identity` value. It never reads headers, so swapping in real auth later only touches the resolver.

## Reversal trigger
If Phase 05 shows that an agent can obtain or replay a session token through a tool, move to per-run, randomly generated tokens that are never shown to the model.
