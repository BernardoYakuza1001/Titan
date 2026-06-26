-- ============================================================================
-- PROJECT TITAN — Phase 1: Viva Wallet FIAT acquiring (MOTO / Card-Not-Present)
-- Immutable financial ledger.
--
-- COMPLIANCE INVARIANT: this table stores the MASKED pan only. Raw PAN is never
-- stored; CVV (Sensitive Authentication Data) is NEVER stored or logged after
-- authorization — there is deliberately no column for either. The POS tokenizes
-- the card inside a PCI-certified component and only a single-use token + masked
-- PAN ever reach the backend.
-- ============================================================================
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

-- Idempotent enum creation (re-runnable migration).
DO $$ BEGIN
  CREATE TYPE fiat_status AS ENUM (
    'FIAT_CREATED',     -- intent persisted, not yet sent to the acquirer
    'FIAT_PROCESSING',  -- submitted to Viva Wallet, awaiting outcome
    'FIAT_APPROVED',    -- authorized (authorization_code present)
    'FIAT_DECLINED'     -- declined / errored (error_log present)
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS fiat_transaction_log (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- idempotency key minted by the POS per sale attempt (see fiat adapter).
  correlation_token   text        NOT NULL,

  terminal_id         text        NOT NULL,
  merchant_id         text        NOT NULL,

  -- money as INTEGER minor units (cents). Never float.
  amount_minor        bigint      NOT NULL CHECK (amount_minor > 0),
  currency            char(3)     NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),

  -- masked only: first-6 (optional) + mask + last-4. A full PAN cannot satisfy
  -- this CHECK, so a coding error can never persist cardholder data here.
  masked_pan          varchar(19) NOT NULL CHECK (masked_pan ~ '^[0-9]{0,6}\*{2,}[0-9]{4}$'),
  card_brand          text        NOT NULL CHECK (card_brand IN
                        ('VISA','MASTERCARD','AMEX','DISCOVER','DINERS','JCB','UNIONPAY','UNKNOWN')),

  -- acquirer outcome (filled as the lifecycle advances)
  viva_transaction_id text,
  viva_order_code     text,
  authorization_code  text,
  error_log           jsonb,

  status              fiat_status NOT NULL DEFAULT 'FIAT_CREATED',

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  -- one logical sale per correlation_token (idempotent retries collapse here)
  CONSTRAINT uq_fiat_correlation UNIQUE (correlation_token)
);

-- terminal history (newest first) for the /terminal/history endpoint + reprints
CREATE INDEX IF NOT EXISTS ix_fiat_terminal_created ON fiat_transaction_log (terminal_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_fiat_merchant_created ON fiat_transaction_log (merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_fiat_viva_txn         ON fiat_transaction_log (viva_transaction_id);

COMMENT ON TABLE fiat_transaction_log IS
  'Immutable MOTO fiat-acquiring ledger. Masked PAN only. Raw PAN/CVV never stored.';
COMMENT ON COLUMN fiat_transaction_log.correlation_token IS
  'POS-minted idempotency key. UNIQUE — a retry with the same token returns the original row.';

-- ---------------------------------------------------------------------------
-- Immutability + forward-only status machine, enforced in the database so no
-- application bug (or compromised service) can rewrite or delete history.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fiat_tx_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'fiat_transaction_log is append-only: DELETE is forbidden';
  END IF;

  -- identity + financial facts are frozen at insert
  IF  NEW.id                <> OLD.id
   OR NEW.correlation_token <> OLD.correlation_token
   OR NEW.terminal_id       <> OLD.terminal_id
   OR NEW.merchant_id       <> OLD.merchant_id
   OR NEW.amount_minor      <> OLD.amount_minor
   OR NEW.currency          <> OLD.currency
   OR NEW.masked_pan        <> OLD.masked_pan
   OR NEW.card_brand        <> OLD.card_brand
   OR NEW.created_at        <> OLD.created_at THEN
    RAISE EXCEPTION 'immutable column modified on fiat_transaction_log';
  END IF;

  -- forward-only lifecycle (enrichment with same status is allowed)
  IF OLD.status = NEW.status THEN
    NULL;
  ELSIF OLD.status = 'FIAT_CREATED'    AND NEW.status IN ('FIAT_PROCESSING','FIAT_DECLINED') THEN
    NULL;
  ELSIF OLD.status = 'FIAT_PROCESSING' AND NEW.status IN ('FIAT_APPROVED','FIAT_DECLINED') THEN
    NULL;
  ELSE
    RAISE EXCEPTION 'illegal fiat status transition: % -> %', OLD.status, NEW.status;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_fiat_tx_no_delete ON fiat_transaction_log;
CREATE TRIGGER trg_fiat_tx_no_delete
  BEFORE DELETE ON fiat_transaction_log
  FOR EACH ROW EXECUTE PROCEDURE fiat_tx_guard();

DROP TRIGGER IF EXISTS trg_fiat_tx_guard_update ON fiat_transaction_log;
CREATE TRIGGER trg_fiat_tx_guard_update
  BEFORE UPDATE ON fiat_transaction_log
  FOR EACH ROW EXECUTE PROCEDURE fiat_tx_guard();

COMMIT;
