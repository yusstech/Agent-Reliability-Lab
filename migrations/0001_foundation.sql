-- Phase 01 foundation schema. See docs/DECISIONS/ADR-0002 and ADR-0003.
--
-- Each schema is a separate ownership boundary. There are deliberately no foreign
-- keys across schemas: the order and carrier systems are independent providers
-- (Phase 02 splits them into separate services), and the ledger only records what
-- it asked them to do. Cross-boundary consistency is the verifier's job, not the DB's.

CREATE SCHEMA identity;     -- accounts, saved addresses, MOCK sessions
CREATE SCHEMA order_svc;    -- simulated order system of record
CREATE SCHEMA carrier_svc;  -- simulated carrier system of record
CREATE SCHEMA ledger;       -- durable operation records owned by the orchestrator

-- ---------------------------------------------------------------- identity

CREATE TABLE identity.customers (
  id text PRIMARY KEY CHECK (id ~ '^cus_[a-z0-9]{1,32}$')
);

CREATE TABLE identity.saved_addresses (
  id                 text PRIMARY KEY CHECK (id ~ '^addr_[a-z0-9]{1,32}$'),
  customer_id        text NOT NULL REFERENCES identity.customers (id),
  normalized_address text NOT NULL CHECK (length(normalized_address) BETWEEN 1 AND 500)
);
CREATE INDEX saved_addresses_customer_idx ON identity.saved_addresses (customer_id);

-- Mock authentication only. Tokens are stored as SHA-256 hashes so even fixture
-- tokens are never readable from the database. Not a production session design.
CREATE TABLE identity.mock_sessions (
  token_sha256 text PRIMARY KEY CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  customer_id  text NOT NULL REFERENCES identity.customers (id)
);

-- ---------------------------------------------------------------- order_svc

CREATE TABLE order_svc.orders (
  id          text PRIMARY KEY CHECK (id ~ '^ord_[a-z0-9]{1,32}$'),
  customer_id text NOT NULL,
  status      text NOT NULL CHECK (status IN ('PLACED', 'PACKING', 'SHIPPED', 'DELIVERED')),
  address_id  text NOT NULL,
  version     integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  carrier_ref text NOT NULL UNIQUE
);
CREATE INDEX orders_customer_idx ON order_svc.orders (customer_id);

-- ---------------------------------------------------------------- carrier_svc

CREATE TABLE carrier_svc.shipments (
  carrier_ref text PRIMARY KEY CHECK (carrier_ref ~ '^shp_[a-z0-9]{1,32}$'),
  address_id  text NOT NULL,
  status      text NOT NULL CHECK (status IN ('AWAITING_PICKUP', 'IN_TRANSIT', 'DELIVERED')),
  version     integer NOT NULL DEFAULT 1 CHECK (version >= 1)
);

-- ---------------------------------------------------------------- ledger

CREATE TABLE ledger.operations (
  id                  text PRIMARY KEY CHECK (id ~ '^op_[a-z0-9]{1,40}$'),
  customer_id         text NOT NULL,
  idempotency_key     text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_-]{8,128}$'),
  -- SHA-256 of the canonical request payload: same key + different payload is rejected.
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  order_id            text NOT NULL,
  target_address_id   text NOT NULL,
  status              text NOT NULL CHECK (status IN (
                        'RECEIVED', 'NEEDS_CONFIRMATION', 'QUEUED', 'UPDATING_ORDER',
                        'UPDATING_CARRIER', 'VERIFYING', 'COMPLETED', 'REJECTED',
                        'PENDING_RECONCILIATION', 'NEEDS_MANUAL_REVIEW')),
  attempts            integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_customer_idempotency_key_uq UNIQUE (customer_id, idempotency_key)
);

-- At most one unresolved address change per order. PENDING_RECONCILIATION counts as
-- unresolved: its side effects are unknown, so a second change must not race it.
-- Keep this list in sync with TERMINAL_STATUSES in src/domain/operation-state.ts.
CREATE UNIQUE INDEX operations_one_unresolved_per_order_uq
  ON ledger.operations (order_id)
  WHERE status NOT IN ('COMPLETED', 'REJECTED', 'NEEDS_MANUAL_REVIEW');

CREATE TABLE ledger.operation_events (
  operation_id       text NOT NULL REFERENCES ledger.operations (id),
  sequence           integer NOT NULL CHECK (sequence >= 1),
  step               text NOT NULL CHECK (step ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  from_status        text CHECK (from_status IN (
                       'RECEIVED', 'NEEDS_CONFIRMATION', 'QUEUED', 'UPDATING_ORDER',
                       'UPDATING_CARRIER', 'VERIFYING', 'COMPLETED', 'REJECTED',
                       'PENDING_RECONCILIATION', 'NEEDS_MANUAL_REVIEW')),
  to_status          text CHECK (to_status IN (
                       'RECEIVED', 'NEEDS_CONFIRMATION', 'QUEUED', 'UPDATING_ORDER',
                       'UPDATING_CARRIER', 'VERIFYING', 'COMPLETED', 'REJECTED',
                       'PENDING_RECONCILIATION', 'NEEDS_MANUAL_REVIEW')),
  reason_code        text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  provider_reference text,
  result             text,
  error_code         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (operation_id, sequence),
  -- A from_status without a to_status is not a transition record.
  CONSTRAINT operation_events_transition_shape CHECK (from_status IS NULL OR to_status IS NOT NULL)
);

-- The event history is evidence; it is append-only.
CREATE FUNCTION ledger.reject_event_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger.operation_events is append-only (% rejected)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER operation_events_append_only
  BEFORE UPDATE OR DELETE ON ledger.operation_events
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_event_mutation();
