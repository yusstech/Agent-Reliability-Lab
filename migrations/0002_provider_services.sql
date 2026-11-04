-- Phase 02: independent provider stores. See docs/DECISIONS/ADR-0008.
--
-- Each provider keeps an append-only log of the address mutations it actually applied.
-- That log is the ground truth for "did the timed-out write happen?" and the source of
-- server-side mutation counters.

CREATE TABLE order_svc.address_mutations (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id            text NOT NULL REFERENCES order_svc.orders (id),
  idempotency_key     text CHECK (idempotency_key ~ '^[A-Za-z0-9_-]{8,128}$'),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  from_address_id     text NOT NULL,
  to_address_id       text NOT NULL,
  from_version        integer NOT NULL,
  to_version          integer NOT NULL CHECK (to_version = from_version + 1),
  applied_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_address_mutations_key_idx ON order_svc.address_mutations (idempotency_key);
CREATE INDEX order_address_mutations_order_idx ON order_svc.address_mutations (order_id);

CREATE TABLE carrier_svc.address_mutations (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  carrier_ref         text NOT NULL REFERENCES carrier_svc.shipments (carrier_ref),
  idempotency_key     text CHECK (idempotency_key ~ '^[A-Za-z0-9_-]{8,128}$'),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  from_address_id     text NOT NULL,
  to_address_id       text NOT NULL,
  from_version        integer NOT NULL,
  to_version          integer NOT NULL CHECK (to_version = from_version + 1),
  applied_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX carrier_address_mutations_key_idx ON carrier_svc.address_mutations (idempotency_key);
CREATE INDEX carrier_address_mutations_ref_idx ON carrier_svc.address_mutations (carrier_ref);

-- ------------------------------------------------------------- provider roles
-- Roles are cluster-wide, so creation is idempotent and tolerant of a concurrent
-- migration in another database on the same server. They cannot log in; provider
-- pools connect as the application user and SET ROLE (ADR-0008 §1).

DO $$
BEGIN
  CREATE ROLE arl_order_svc NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE ROLE arl_carrier_svc NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Lets a non-superuser application user SET ROLE; a no-op for superusers.
GRANT arl_order_svc TO CURRENT_USER;
GRANT arl_carrier_svc TO CURRENT_USER;

GRANT USAGE ON SCHEMA order_svc TO arl_order_svc;
GRANT SELECT, INSERT, UPDATE ON order_svc.orders TO arl_order_svc;
GRANT SELECT, INSERT ON order_svc.address_mutations TO arl_order_svc;  -- append-only for the service

GRANT USAGE ON SCHEMA carrier_svc TO arl_carrier_svc;
GRANT SELECT, INSERT, UPDATE ON carrier_svc.shipments TO arl_carrier_svc;
GRANT SELECT, INSERT ON carrier_svc.address_mutations TO arl_carrier_svc;
