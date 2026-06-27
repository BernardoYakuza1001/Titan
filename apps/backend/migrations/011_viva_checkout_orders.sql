-- ============================================================================
-- PROJECT TITAN — Viva Smart Checkout (hosted order) payment confirmation.
--
-- The hosted-checkout flow is asynchronous: the backend CREATES an order, the
-- customer pays on Viva's hosted page, and Viva later notifies us by webhook.
-- This table is the source of truth for that order's lifecycle. It records NO
-- card data (the card is entered on Viva's page) — only the order economics and
-- the resulting Viva transaction id once a payment is independently confirmed.
--
-- Immutable + forward-only (PENDING -> PAID | FAILED), enforced in the database
-- so no application bug can rewrite a settled order. Idempotent / re-runnable.
-- ============================================================================
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- (kept consistent with 010; not required here)

-- Idempotent enum creation (re-runnable migration).
DO $$ BEGIN
  CREATE TYPE checkout_status AS ENUM (
    'PENDING',   -- order created at Viva, awaiting the customer's payment
    'PAID',      -- payment independently confirmed via Viva transaction lookup
    'FAILED'     -- Viva reported the transaction failed
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS checkout_order (
  -- Viva's order code is the natural key the webhook reports back.
  order_code          text        PRIMARY KEY,

  -- POS-minted idempotency key per sale attempt (one order per token).
  correlation_token   text        NOT NULL,

  terminal_id         text        NOT NULL,
  merchant_id         text        NOT NULL,

  -- money as INTEGER minor units (cents). Never float.
  amount_minor        bigint      NOT NULL CHECK (amount_minor > 0),
  currency            char(3)     NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),

  status              checkout_status NOT NULL DEFAULT 'PENDING',

  -- filled only when a payment is CONFIRMED against Viva's transaction API.
  viva_transaction_id text,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  paid_at             timestamptz,

  -- one logical order per correlation_token (idempotent retries collapse here)
  CONSTRAINT uq_checkout_correlation UNIQUE (correlation_token)
);

CREATE INDEX IF NOT EXISTS ix_checkout_terminal_created ON checkout_order (terminal_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_checkout_status          ON checkout_order (status);

COMMENT ON TABLE checkout_order IS
  'Viva Smart Checkout order lifecycle. No card data. Immutable, forward-only PENDING->PAID|FAILED.';

-- ---------------------------------------------------------------------------
-- Immutability + forward-only status machine, enforced in the database.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION checkout_order_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'checkout_order is append-only: DELETE is forbidden';
  END IF;

  -- identity + financial facts are frozen at insert
  IF  NEW.order_code        <> OLD.order_code
   OR NEW.correlation_token <> OLD.correlation_token
   OR NEW.terminal_id       <> OLD.terminal_id
   OR NEW.merchant_id       <> OLD.merchant_id
   OR NEW.amount_minor      <> OLD.amount_minor
   OR NEW.currency          <> OLD.currency
   OR NEW.created_at        <> OLD.created_at THEN
    RAISE EXCEPTION 'immutable column modified on checkout_order';
  END IF;

  -- forward-only lifecycle (enrichment with same status is allowed)
  IF OLD.status = NEW.status THEN
    NULL;
  ELSIF OLD.status = 'PENDING' AND NEW.status IN ('PAID','FAILED') THEN
    NULL;
  ELSE
    RAISE EXCEPTION 'illegal checkout status transition: % -> %', OLD.status, NEW.status;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_checkout_no_delete ON checkout_order;
CREATE TRIGGER trg_checkout_no_delete
  BEFORE DELETE ON checkout_order
  FOR EACH ROW EXECUTE PROCEDURE checkout_order_guard();

DROP TRIGGER IF EXISTS trg_checkout_guard_update ON checkout_order;
CREATE TRIGGER trg_checkout_guard_update
  BEFORE UPDATE ON checkout_order
  FOR EACH ROW EXECUTE PROCEDURE checkout_order_guard();

COMMIT;
