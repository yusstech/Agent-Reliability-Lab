-- Phase 03: deterministic workflow (ADR-0009). Adds COMPENSATING, worker leases and
-- retry scheduling, request context, event detail, and server-issued consent challenges.

ALTER TABLE ledger.operations DROP CONSTRAINT operations_status_check;
ALTER TABLE ledger.operations ADD CONSTRAINT operations_status_check CHECK (status IN (
  'RECEIVED', 'NEEDS_CONFIRMATION', 'QUEUED', 'UPDATING_ORDER', 'UPDATING_CARRIER',
  'VERIFYING', 'COMPENSATING', 'COMPLETED', 'REJECTED', 'PENDING_RECONCILIATION',
  'NEEDS_MANUAL_REVIEW'));

ALTER TABLE ledger.operation_events DROP CONSTRAINT operation_events_from_status_check;
ALTER TABLE ledger.operation_events DROP CONSTRAINT operation_events_to_status_check;
ALTER TABLE ledger.operation_events ADD CONSTRAINT operation_events_from_status_check CHECK (from_status IN (
  'RECEIVED', 'NEEDS_CONFIRMATION', 'QUEUED', 'UPDATING_ORDER', 'UPDATING_CARRIER',
  'VERIFYING', 'COMPENSATING', 'COMPLETED', 'REJECTED', 'PENDING_RECONCILIATION',
  'NEEDS_MANUAL_REVIEW'));
ALTER TABLE ledger.operation_events ADD CONSTRAINT operation_events_to_status_check CHECK (to_status IN (
  'RECEIVED', 'NEEDS_CONFIRMATION', 'QUEUED', 'UPDATING_ORDER', 'UPDATING_CARRIER',
  'VERIFYING', 'COMPENSATING', 'COMPLETED', 'REJECTED', 'PENDING_RECONCILIATION',
  'NEEDS_MANUAL_REVIEW'));

-- Structured, non-secret context for each event (versions, keys, addresses seen).
ALTER TABLE ledger.operation_events ADD COLUMN detail jsonb;

ALTER TABLE ledger.operations
  ADD COLUMN carrier_ref             text,
  ADD COLUMN original_address_id     text,
  ADD COLUMN validated_order_version integer CHECK (validated_order_version >= 1),
  ADD COLUMN public_reason           text CHECK (public_reason ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  ADD COLUMN step_attempts           integer NOT NULL DEFAULT 0 CHECK (step_attempts >= 0),
  ADD COLUMN next_attempt_at         timestamptz,
  ADD COLUMN lease_token             uuid,
  ADD COLUMN lease_expires_at        timestamptz,
  ADD CONSTRAINT operations_lease_shape CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL));

-- Work the worker can pick up (NEEDS_CONFIRMATION is swept only once expired).
CREATE INDEX operations_claimable_idx ON ledger.operations (created_at)
  WHERE status IN ('NEEDS_CONFIRMATION', 'QUEUED', 'UPDATING_ORDER', 'UPDATING_CARRIER',
                   'VERIFYING', 'COMPENSATING', 'PENDING_RECONCILIATION');

-- Server-issued consent challenge. Only the token's hash is stored.
CREATE TABLE ledger.confirmations (
  operation_id text PRIMARY KEY REFERENCES ledger.operations (id),
  token_sha256 text NOT NULL CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  expires_at   timestamptz NOT NULL,
  confirmed_at timestamptz
);
