/**
 * PROJECT TITAN — Crypto Execution Engine unit proof (integration owner).
 *
 * Exercises the REAL CryptoExecEngine + SmartOrderRouter against configurable
 * InMemoryExchange venues (no network, injected fakes). Asserts the money-safety
 * invariants the saga depends on at the LAST reversible step (crypto buy):
 *
 *   - best execution picks the cheapest NET venue (fee-inclusive, not raw price);
 *   - a slippage breach returns ok:false (saga then reverses fiat — pre-commit);
 *   - a venue REJECT falls back to the next-best venue;
 *   - all venues down returns ok:false (structured, never throws);
 *   - an idempotent buy (same ctx.id) places exactly ONE order at the venue.
 *
 * Money is decimal strings / integer math throughout — no floats.
 */
import { CryptoExecEngine } from '../services/crypto-exec/crypto-exec.engine';
import { InMemoryExchange } from '../services/crypto-exec/testing/in-memory-exchange';
import { TransactionContext } from '../services/transaction/transaction.saga';
import { ResolvedProfile } from '@titan/profile-schema';

function profile(): ResolvedProfile {
  return {
    id: '33333333-3333-3333-3333-333333333333', label: '101.3', family: '101', version: 1,
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

describe('CryptoExecEngine (real) — best execution & safety', () => {
  it('picks the cheapest NET venue (fee-inclusive, not raw price)', async () => {
    // venueA: lower raw price (60000) but 100 bps fee -> net 60600.
    // venueB: higher raw price (60200) but 10 bps fee  -> net 60260.2 (cheaper net).
    const a = new InMemoryExchange({ name: 'venueA', price: '60000', feeBps: 100 });
    const b = new InMemoryExchange({ name: 'venueB', price: '60200', feeBps: 10 });
    const engine = new CryptoExecEngine([a, b], { maxSlippageBps: 100 });

    const res = await engine.buy(ctx());

    expect(res.ok).toBe(true);
    expect(res.venue).toBe('venueB');     // cheapest NET wins, not cheapest raw
    expect(typeof res.qty).toBe('string'); // money rule: qty is a decimal string
    expect(b.placements).toBe(1);
    expect(a.placements).toBe(0);          // pricier-net venue never touched
  });

  it('slippage breach -> ok:false (no fill accepted beyond tolerance)', async () => {
    // Quote 60000, fill executes at 60900 = +150 bps; tolerance is 50 bps.
    const v = new InMemoryExchange({ name: 'slippy', price: '60000', feeBps: 0, fillPrice: '60900' });
    const engine = new CryptoExecEngine([v], { maxSlippageBps: 50 });

    const res = await engine.buy(ctx());

    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/SLIPPAGE_EXCEEDED/);
    expect(res.qty).toBeUndefined();
  });

  it('venue fallback: the best venue REJECTs -> rolls to the next-best', async () => {
    const best = new InMemoryExchange({ name: 'best', price: '60000', feeBps: 0, reject: 'INSUFFICIENT_LIQUIDITY' });
    const next = new InMemoryExchange({ name: 'next', price: '60100', feeBps: 0 });
    const engine = new CryptoExecEngine([best, next], { maxSlippageBps: 100 });

    const res = await engine.buy(ctx());

    expect(res.ok).toBe(true);
    expect(res.venue).toBe('next');   // fell back to the next-best venue
    expect(best.placements).toBe(1);  // best WAS attempted (then rejected)
    expect(next.placements).toBe(1);
  });

  it('all venues down -> ok:false (structured failure, never throws)', async () => {
    const down = new InMemoryExchange({ name: 'down', price: '60000', feeBps: 0, up: false });
    const noWd = new InMemoryExchange({ name: 'noWd', price: '60000', feeBps: 0, withdrawalsEnabled: false });
    const engine = new CryptoExecEngine([down, noWd], { maxSlippageBps: 100 });

    const res = await engine.buy(ctx());

    expect(res.ok).toBe(false);
    expect(res.reason).toBe('NO_HEALTHY_VENUE');
    expect(down.placements).toBe(0);
    expect(noWd.placements).toBe(0);
  });

  it('idempotent buy: the same ctx.id places exactly ONE order at the venue', async () => {
    const v = new InMemoryExchange({ name: 'v', price: '60000', feeBps: 0 });
    const engine = new CryptoExecEngine([v], { maxSlippageBps: 100 });
    const c = ctx({ id: 'tx_idem_1' });

    const r1 = await engine.buy(c);
    const r2 = await engine.buy(c); // saga retry / at-least-once redelivery

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r1.qty).toBe(r2.qty);                                 // same fill returned
    expect(v.placements).toBe(1);                                // exactly ONE real order
    expect([...v.orders.keys()]).toEqual(['titan:tx_idem_1']);   // deterministic order id
  });
});
