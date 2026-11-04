# ADR-0005: Single error envelope with stable machine codes

- **Status:** Accepted
- **Date:** 2026-11-02
- **Phase:** 01

## Context
The evaluation harness (Phase 04) and the agent variants (Phase 05) will branch on API failures. If errors arrive in framework-specific shapes or change wording between library versions, classifications become unreliable.

## Options considered
1. **Fastify defaults** (`{statusCode, error, message}`). Zero work, but the shape varies by error source, and validator messages leak library internals.
2. **RFC 9457 Problem Details.** A standard, but more ceremony than this prototype needs, and it still requires a stable code vocabulary on top.
3. **A custom envelope:** `{"error": {"code", "message", "request_id", "details?"}}`. `code` comes from a closed list ([errors.ts](../../src/http/errors.ts)). `details[]` is `{path, issue, message}`, where `issue` is drawn from a closed vocabulary and sorted deterministically.

## Decision
Option 3. Clients branch on `code` and `details[].issue`, never on `message`. Every response carries a server-generated `x-request-id`, and client-supplied request IDs are ignored (API-10). Internal errors return `INTERNAL` without exposing exception text.

## Consequences
- Framework errors (malformed JSON, empty body, wrong content type, oversized body, 404) are mapped explicitly (API-08, API-10). Any other framework 4xx keeps its status with code `BAD_REQUEST`. Only real server faults become `INTERNAL`.
- The API accepts JSON only. Fastify's default `text/plain` parser is removed, so a non-JSON body gets `415` rather than reaching the validator.
- Zod is pinned (`save-exact`), and its issue codes are translated rather than passed through, so a validator upgrade can't change the public contract unnoticed.

## Reversal trigger
If the project is published as a reusable reference API, re-evaluate Problem Details for interoperability.
