/**
 * PROJECT TITAN — Transaction saga re-entrancy + failure-classification proof.
 *
 * These tests pin the safety-critical invariants for crash recovery and error
 * handling that the e2e suite (which always starts from a fresh CREATED ctx)
 * does not exercise:
 *
 *   #4 RE-ENTRANCY: resuming run() on a ctx persisted at a POST-COMMIT state
 *      (CRYPTO_EXECUTING / DELIVERING / CONFIRMING) must drive FORWARD to a
 *      terminal state (COMPLETED, or FAILED + treasury case) — never return
 *      silently stuck in a non-terminal post-commit state with funds unreconciled.
 *
 *   #5 FAILURE CLASSIFICATION: a PRE-COMMIT throw (e.g. crypto.buy throws while in
 *      CRYPTO_PENDING) must VOID the fiat auth and land REVERSED — exactly one
 *      void, zero treasury cases, no unhandled rejection. A POST-COMMIT throw must
 *      open a treasury case and land FAILED via a LEGAL transition.
 *
 * All fakes are in-memory + deterministic; the saga, state machine, and ledger
 * are the REAL implementations.
 */
import { TransactionSaga, TransactionContext } from './transaction.saga';
import { LedgerService, LedgerStore, LedgerEvent } from '../../libs/ledger/ledger.service';
import { TxState } from '../../libs/state-machine/transaction.state-machine';
import { ResolvedProfile } from '@titan/profile-schema';

// ---- in-memory ledger ----
class MemLedgerStore implements LedgerStore {
  events: LedgerEvent[] = [];
  async lastHash(id: string) { const e = this.events.filter(x => x.aggregateId === id); return e.length ? e[e.length - 1].hash : null; }
  async append(e: LedgerEvent) { this.events.push(e); }
  async list(id: string) { return this.events.filter(x => x.aggregateId === id); }
}

function profile(): ResolvedProfile {
  return {
    id: '55555555-5555-5555-5555-555555555555', label: '101.3', family: '101', version: 1,
    signature: 'sig', resolvedFor: 'dev1', etag: 'e1', expiresAt: '2999-01-01T00:00:00.000Z',
    dimensions: {
      processorRoute: 'route_eu_a',
      approvalPolicy: { type: 'OOB_OTP', length: 6, preAuth: true, stepUpTriggers: [] },
      captureMethods: { card: ['EMV'], wallet: ['QR'] },
      kycLevel: 'FULL_LIVENESS',
      assetSet: ['BTC'],
      walletValidation: { enforceChecksum: true, screenDestination: true, blockMixers: true },
      riskTier: 'tier_std',
      txCaps: { perTxn: 1_000_000, daily: 3_000_000, currency: 'EUR' },
      settlementRoute: 'settle_eu', compliancePack: 'EU_MiCA_TFR', deliveryStrategy: 'BUY_THEN_SEND',
    },
  };
}

function ctx(over: Partial<TransactionContext> = {}): TransactionContext {
  return {
    id: over.id ?? 'tx_' + Math.random().toString(36).slice(2),
    deviceId: 'dev1', profile: profile(),
    fiatAmount: 1000, fiatCurrency: 'EUR', asset: 'BTC', chain: 'bitcoin',
    destWallet: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', state: 'CRYPTO_PENDING',
    customerId: 'cust_1', cardToken: 'tok_1', geoCountry: 'DE',
    ...over,
  };
}

// ---- configurable saga harness with call-counting fakes ----
interface Spies {
  voidCalls: number;
  buyCalls: number;
  sendCalls: number;
  confirmCalls: number;
  cases: string[];
}
function build(opts: {
  buy?: () => Promise<any>;
  send?: () => Promise<any>;
  awaitConfirmations?: () => Promise<boolean>;
} = {}) {
  const spies: Spies = { voidCalls: 0, buyCalls: 0, sendCalls: 0, confirmCalls: 0, cases: [] };
  const ledger = new LedgerService(new MemLedgerStore(), () => '2026-01-01T00:00:00.000Z');
  const auth = {
    authorize: async () => ({ ok: true, authCode: 'a' }),
    void: async () => { spies.voidCalls++; },
  };
  const compliance = { check: async () => ({ allow: true, reasons: [] }) };
  const risk = { evaluate: async () => ({ allow: true, score: 1, reasons: [] }) };
  const crypto = {
    buy: opts.buy ?? (async () => { spies.buyCalls++; return { ok: true, qty: '0.01', venue: 'kraken' }; }),
  };
  // Wrap the default buy so the counter still increments when a custom buy is used.
  if (opts.buy) {
    const inner = opts.buy;
    crypto.buy = async (...a: any[]) => { spies.buyCalls++; return inner.apply(null, a as []); };
  }
  const delivery = {
    send: opts.send
      ? async (...a: any[]) => { spies.sendCalls++; return (opts.send as any).apply(null, a); }
      : async () => { spies.sendCalls++; return { ok: true, txid: '0xfeed' }; },
    awaitConfirmations: opts.awaitConfirmations
      ? async (...a: any[]) => { spies.confirmCalls++; return (opts.awaitConfirmations as any).apply(null, a); }
      : async () => { spies.confirmCalls++; return true; },
  };
  const cases = { async openTreasuryReconciliation(id: string) { spies.cases.push(id); } };
  const store = new Map<string, TransactionContext>();
  const repo = { async save(c: TransactionContext) { store.set(c.id, c); } };
  const saga = new TransactionSaga(
    ledger, auth as any, compliance as any, risk as any, crypto as any, delivery as any, cases, repo,
  );
  return { saga, spies };
}

describe('saga re-entrancy on post-commit states (#4)', () => {
  it('resumes from CRYPTO_EXECUTING (bought, crash before send) -> COMPLETED, sends once', async () => {
    const { saga, spies } = build();
    // qty is the persisted artifact a real resume would reload.
    const c = ctx({ id: 't_resume_exec', state: 'CRYPTO_EXECUTING', cryptoQty: '0.01' });
    const final = await saga.run(c);
    expect(final).toBe('COMPLETED');
    expect(spies.buyCalls).toBe(0);     // never re-buys on resume
    expect(spies.sendCalls).toBe(1);    // delivery resumed
    expect(spies.confirmCalls).toBe(1);
    expect(spies.cases.length).toBe(0); // clean forward completion, no case
  });

  it('resumes from DELIVERING (sent, crash before confirm) -> COMPLETED, polls confirmations', async () => {
    const { saga, spies } = build();
    const c = ctx({ id: 't_resume_deliver', state: 'DELIVERING', cryptoQty: '0.01', deliveryTxid: '0xfeed' });
    const final = await saga.run(c);
    expect(final).toBe('COMPLETED');
    expect(spies.sendCalls).toBe(0);    // not re-sent
    expect(spies.confirmCalls).toBe(1); // confirmation resumed
  });

  it('resumes from CONFIRMING -> COMPLETED', async () => {
    const { saga, spies } = build();
    const c = ctx({ id: 't_resume_confirm', state: 'CONFIRMING', cryptoQty: '0.01', deliveryTxid: '0xfeed' });
    const final = await saga.run(c);
    expect(final).toBe('COMPLETED');
    expect(spies.sendCalls).toBe(0);
    expect(spies.confirmCalls).toBe(0); // already confirmed; just finalize
  });

  it('resume from CRYPTO_EXECUTING with a failing broadcast -> FAILED + treasury case', async () => {
    const { saga, spies } = build({ send: async () => ({ ok: false, reason: 'NODE_REJECTED' }) });
    const c = ctx({ id: 't_resume_fail', state: 'CRYPTO_EXECUTING', cryptoQty: '0.01' });
    const final = await saga.run(c);
    expect(final).toBe('FAILED');
    expect(spies.cases.length).toBe(1); // post-commit -> case opened
  });

  it('resume from CRYPTO_EXECUTING with NO recoverable qty -> FAILED + case (never guesses)', async () => {
    const { saga, spies } = build();
    const c = ctx({ id: 't_no_qty', state: 'CRYPTO_EXECUTING' }); // cryptoQty undefined
    const final = await saga.run(c);
    expect(final).toBe('FAILED');
    expect(spies.sendCalls).toBe(0);    // never sends a guessed amount
    expect(spies.cases.length).toBe(1);
  });

  it('a confirmation timeout on resume from DELIVERING -> FAILED + case', async () => {
    const { saga, spies } = build({ awaitConfirmations: async () => false });
    const c = ctx({ id: 't_confirm_to', state: 'DELIVERING', cryptoQty: '0.01', deliveryTxid: '0xfeed' });
    const final = await saga.run(c);
    expect(final).toBe('FAILED');
    expect(spies.cases.length).toBe(1);
  });
});

describe('saga failure classification (#5)', () => {
  it('crypto.buy THROWS in CRYPTO_PENDING -> REVERSED, void once, ZERO cases, no rejection', async () => {
    const { saga, spies } = build({ buy: async () => { throw new Error('venue network blip'); } });
    const c = ctx({ id: 't_buy_throws', state: 'CRYPTO_PENDING' });
    const final = await saga.run(c); // must resolve, never reject
    expect(final).toBe('REVERSED');
    expect(spies.voidCalls).toBe(1);    // fiat auth voided exactly once
    expect(spies.cases.length).toBe(0); // pre-commit: NO false treasury case
    expect(spies.sendCalls).toBe(0);    // nothing delivered
  });

  it('a POST-COMMIT throw (delivery.send throws in CRYPTO_EXECUTING) -> FAILED + case, no rejection', async () => {
    const { saga, spies } = build({ send: async () => { throw new Error('broadcast exploded'); } });
    const c = ctx({ id: 't_send_throws', state: 'CRYPTO_EXECUTING', cryptoQty: '0.01' });
    const final = await saga.run(c);
    expect(final).toBe('FAILED');
    expect(spies.voidCalls).toBe(0);    // post-commit: fiat NOT voided (we hold crypto)
    expect(spies.cases.length).toBe(1); // treasury case opened
  });

  it('a full fresh run still completes (no regression)', async () => {
    const { saga, spies } = build();
    const c = ctx({ id: 't_fresh', state: 'CREATED' });
    const final = await saga.run(c);
    expect(final).toBe('COMPLETED');
    expect(spies.buyCalls).toBe(1);
    expect(spies.sendCalls).toBe(1);
  });
});
