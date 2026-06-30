-- ============================================================================
-- PROJECT TITAN — widen the recurring status machine for the PROCESSING state.
--
-- Allows CREATED -> PROCESSING -> APPROVED|DECLINED (and the CREATED ->
-- APPROVED|DECLINED fast path), so a timed-out-but-maybe-captured charge can be
-- parked as PROCESSING and later reconciled to a terminal state. APPROVED and
-- DECLINED remain terminal. Immutable frozen columns + no-DELETE unchanged.
-- Re-runnable (CREATE OR REPLACE).
-- ============================================================================
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
  ELSIF OLD.status = 'RECURRING_CREATED'
        AND NEW.status IN ('RECURRING_PROCESSING','RECURRING_APPROVED','RECURRING_DECLINED') THEN
    NULL;
  ELSIF OLD.status = 'RECURRING_PROCESSING'
        AND NEW.status IN ('RECURRING_APPROVED','RECURRING_DECLINED') THEN
    NULL;
  ELSE
    RAISE EXCEPTION 'illegal recurring status transition: % -> %', OLD.status, NEW.status;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
