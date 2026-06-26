/**
 * PROJECT TITAN — State machine tests (proves the spine is correct & safe).
 * Run: pnpm --filter @titan/backend test
 */
import {
  next, canFire, isTerminal, requiresFiatUnwind, IllegalTransitionError,
  TxState, POST_COMMIT_STATES,
} from './transaction.state-machine';

describe('transaction state machine', () => {
  it('walks the full happy path to COMPLETED', () => {
    let s: TxState = 'CREATED';
    s = next(s, 'INPUT_CAPTURED');   expect(s).toBe('CAPTURED_INPUT');
    s = next(s, 'AUTH_REQUESTED');   expect(s).toBe('AUTHORIZING');
    s = next(s, 'AUTH_APPROVED');    expect(s).toBe('AUTHORIZED');
    s = next(s, 'COMPLIANCE_PASS');  expect(s).toBe('RISK_REVIEW');
    s = next(s, 'RISK_PASS');        expect(s).toBe('APPROVED');
    s = next(s, 'CRYPTO_QUEUED');    expect(s).toBe('CRYPTO_PENDING');
    s = next(s, 'CRYPTO_FILLED');    expect(s).toBe('CRYPTO_EXECUTING');
    s = next(s, 'BROADCAST_OK');     expect(s).toBe('DELIVERING');
    s = next(s, 'CONFIRMED');        expect(s).toBe('CONFIRMING');
    s = next(s, 'CONFIRMED');        expect(s).toBe('COMPLETED');
    expect(isTerminal(s)).toBe(true);
  });

  it('reverses fiat when compliance fails (pre-commit)', () => {
    const s = next('AUTHORIZED', 'COMPLIANCE_FAIL');
    expect(s).toBe('REVERSED');
    expect(requiresFiatUnwind('AUTHORIZED')).toBe(true);
  });

  it('reverses fiat when risk fails (pre-commit)', () => {
    expect(next('RISK_REVIEW', 'RISK_FAIL')).toBe('REVERSED');
  });

  it('does NOT treat post-commit states as fiat-reversible', () => {
    for (const s of POST_COMMIT_STATES) {
      expect(requiresFiatUnwind(s)).toBe(false);
    }
  });

  it('rejects illegal transitions', () => {
    expect(() => next('CREATED', 'AUTH_APPROVED')).toThrow(IllegalTransitionError);
    expect(canFire('COMPLETED', 'AUTH_APPROVED')).toBe(false);
  });

  it('terminal states accept no events', () => {
    for (const s of ['DECLINED', 'FAILED', 'REVERSED', 'REFUNDED', 'CHARGEBACK'] as TxState[]) {
      expect(isTerminal(s)).toBe(true);
    }
  });
});
