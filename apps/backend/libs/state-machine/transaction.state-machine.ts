/**
 * PROJECT TITAN — Transaction State Machine (Phase 4)
 *
 * The canonical lifecycle of a fiat->crypto transaction. Encoded as an explicit,
 * auditable FSM because crypto delivery is IRREVERSIBLE: every transition is a
 * ledger event, money-moving transitions are saga steps with compensations, and
 * compliance/risk are MANDATORY states (Principle P2) — not optional calls.
 *
 * This module is pure (no I/O) so it is trivially unit-testable and reusable by
 * the saga orchestrator and by replay/audit tooling.
 */

export type TxState =
  | 'CREATED'
  | 'CAPTURED_INPUT'
  | 'AUTHORIZING'        // fiat auth in flight
  | 'AUTHORIZED'         // fiat hold obtained
  | 'COMPLIANCE_HOLD'    // KYC / sanctions / travel-rule (blocking)
  | 'RISK_REVIEW'        // real-time risk scoring (blocking)
  | 'APPROVED'           // cleared to spend crypto
  | 'CRYPTO_PENDING'
  | 'CRYPTO_EXECUTING'   // buying spot on exchange
  | 'DELIVERING'         // broadcasting on-chain
  | 'CONFIRMING'         // waiting for N confirmations
  | 'COMPLETED'          // terminal (success)
  // terminal failure / unwind states
  | 'DECLINED'           // terminal — rejected pre-spend (no fiat captured to crypto)
  | 'FAILED'             // terminal — error after some progress
  | 'REVERSED'           // terminal — fiat auth voided/refunded
  | 'REFUNDED'           // terminal — treasury-funded refund post-delivery
  | 'CHARGEBACK';        // terminal — network-initiated dispute lost

export type TxEvent =
  | 'INPUT_CAPTURED'
  | 'AUTH_REQUESTED'
  | 'AUTH_APPROVED'
  | 'AUTH_DECLINED'
  | 'COMPLIANCE_PASS'
  | 'COMPLIANCE_FAIL'
  | 'RISK_PASS'
  | 'RISK_FAIL'
  | 'CRYPTO_QUEUED'
  | 'CRYPTO_FILLED'
  | 'CRYPTO_EXEC_FAILED'
  | 'BROADCAST_OK'
  | 'BROADCAST_FAILED'
  | 'CONFIRMED'
  | 'VOID_OK'
  | 'CHARGEBACK_RECEIVED';

export const TERMINAL_STATES: ReadonlySet<TxState> = new Set([
  'COMPLETED', 'DECLINED', 'FAILED', 'REVERSED', 'REFUNDED', 'CHARGEBACK',
]);

/** States past which fiat value has been committed toward irreversible crypto. */
export const POST_COMMIT_STATES: ReadonlySet<TxState> = new Set([
  'CRYPTO_EXECUTING', 'DELIVERING', 'CONFIRMING', 'COMPLETED',
]);

type TransitionTable = Record<TxState, Partial<Record<TxEvent, TxState>>>;

const transitions: TransitionTable = {
  CREATED:          { INPUT_CAPTURED: 'CAPTURED_INPUT' },
  CAPTURED_INPUT:   { AUTH_REQUESTED: 'AUTHORIZING' },
  AUTHORIZING:      { AUTH_APPROVED: 'AUTHORIZED', AUTH_DECLINED: 'DECLINED' },
  AUTHORIZED:       { COMPLIANCE_PASS: 'RISK_REVIEW', COMPLIANCE_FAIL: 'REVERSED' },
  COMPLIANCE_HOLD:  { COMPLIANCE_PASS: 'RISK_REVIEW', COMPLIANCE_FAIL: 'REVERSED' },
  RISK_REVIEW:      { RISK_PASS: 'APPROVED', RISK_FAIL: 'REVERSED' },
  APPROVED:         { CRYPTO_QUEUED: 'CRYPTO_PENDING' },
  CRYPTO_PENDING:   { CRYPTO_FILLED: 'CRYPTO_EXECUTING', CRYPTO_EXEC_FAILED: 'REVERSED' },
  CRYPTO_EXECUTING: { BROADCAST_OK: 'DELIVERING', BROADCAST_FAILED: 'FAILED' },
  DELIVERING:       { CONFIRMED: 'CONFIRMING', BROADCAST_FAILED: 'FAILED' },
  CONFIRMING:       { CONFIRMED: 'COMPLETED' },
  COMPLETED:        { CHARGEBACK_RECEIVED: 'CHARGEBACK' },
  // terminal states accept no events
  DECLINED: {}, FAILED: {}, REVERSED: {}, REFUNDED: {}, CHARGEBACK: {},
};

export class IllegalTransitionError extends Error {
  constructor(public readonly from: TxState, public readonly event: TxEvent) {
    super(`Illegal transition: ${from} --(${event})-->`);
    this.name = 'IllegalTransitionError';
  }
}

/** Pure transition function. Throws on illegal transitions (caught by saga -> FAILED). */
export function next(from: TxState, event: TxEvent): TxState {
  const to = transitions[from]?.[event];
  if (!to) throw new IllegalTransitionError(from, event);
  return to;
}

export function canFire(from: TxState, event: TxEvent): boolean {
  return Boolean(transitions[from]?.[event]);
}

export function isTerminal(state: TxState): boolean {
  return TERMINAL_STATES.has(state);
}

/**
 * Whether a failure at `state` requires fiat unwind (void/refund). Used by the
 * saga to choose compensation: pre-commit -> void auth; post-commit -> treasury
 * reconcile + possible REFUND, since crypto cannot be clawed back.
 */
export function requiresFiatUnwind(state: TxState): boolean {
  return state === 'AUTHORIZED' || state === 'COMPLIANCE_HOLD' ||
         state === 'RISK_REVIEW' || state === 'APPROVED' || state === 'CRYPTO_PENDING';
}
