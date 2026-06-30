-- ============================================================================
-- PROJECT TITAN — Recurring / Merchant-Initiated Transaction (MIT) charges.
--
-- After ONE customer-present, 3DS-authenticated payment created with
-- AllowRecurring=true (the customer consenting to future merchant-initiated
-- charges), the merchant may charge that cardholder again server-side with NO
-- 3DS/OTP, by chaining off the INITIAL transaction id. This table is the
-- immutable audit log of those merchant-initiated charges.
--
-- COMPLIANCE: each row references the initial (authenticated) transaction the
-- mandate was established on. No card data is stored — only the Viva ids + money.
-- Immutable + forward-only, enforced in the DB. Idempotent / re-runnable.
-- ============================================================================
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

DO $$ BEGIN
  CREATE TYPE recurring_status AS ENUM (
    'RECURRING_CREATED',    -- intent persisted, not yet sent
    'RECURRING_APPROVED',   -- Viva charged the MIT (StatusId 'F')
    'RECURRING_DECLINED'    -- declined / errored
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS recurring_charge (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- POS-minted idempotency key per MIT attempt (one charge per token).
  correlation_token     text        NOT NULL,

  terminal_id           text        NOT NULL,
  merchant_id           text        NOT NULL,

  -- the initial AUTHENTICATED transaction the recurring mandate chains from.
  initial_transaction_id text       NOT NULL,

  amount_minor          bigint      NOT NULL CHECK (amount_minor > 0),
  currency              char(3)     NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),

  viva_transaction_id   text,       -- the resulting MIT transaction id
  error_log             jsonb,

  status                recurring_status NOT NULL DEFAULT 'RECURRING_CREATED',

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_recurring_correlation UNIQUE (correlation_token)
);

CREATE INDEX IF NOT EXISTS ix_recurring_terminal_created ON recurring_charge (terminal_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_recurring_initial_txn      ON recurring_charge (initial_transaction_id);

COMMENT ON TABLE recurring_charge IS
  'Immutable audit of merchant-initiated (recurring) charges. No card data. Chains off the initial authenticated transaction id.';

-- ---------------------------------------------------------------------------
-- Immutability + forward-only status machine, enforced in the database.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION recurring_charge_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'recurring_charge is append-only: DELETE is forbidden';
  END IF;

  IF  NEW.id                     <> OLD.id
   OR NEW.correlation_token       <> OLD.correlation_token
   OR NEW.terminal_id             <> OLD.terminal_id
   OR NEW.merchant_id             <> OLD.merchant_id
   OR NEW.initial_transaction_id  <> OLD.initial_transaction_id
   OR NEW.amount_minor            <> OLD.amount_minor
   OR NEW.currency                <> OLD.currency
   OR NEW.created_at              <> OLD.created_at THEN
    RAISE EXCEPTION 'immutable column modified on recurring_charge';
  END IF;

  IF OLD.status = NEW.status THEN
    NULL;
  ELSIF OLD.status = 'RECURRING_CREATED' AND NEW.status IN ('RECURRING_APPROVED','RECURRING_DECLINED') THEN
    NULL;
  ELSE
    RAISE EXCEPTION 'illegal recurring status transition: % -> %', OLD.status, NEW.status;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_recurring_no_delete ON recurring_charge;
CREATE TRIGGER trg_recurring_no_delete
  BEFORE DELETE ON recurring_charge
  FOR EACH ROW EXECUTE PROCEDURE recurring_charge_guard();

DROP TRIGGER IF EXISTS trg_recurring_guard_update ON recurring_charge;
CREATE TRIGGER trg_recurring_guard_update
  BEFORE UPDATE ON recurring_charge
  FOR EACH ROW EXECUTE PROCEDURE recurring_charge_guard();

COMMIT;
