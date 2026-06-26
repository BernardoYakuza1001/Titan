/**
 * PROJECT TITAN — Crypto Execution Engine integration proof (Phase 5).
 *
 * Wires the REAL CryptoExecEngine + SmartOrderRouter against configurable
 * InMemoryExchange venues and asserts the safety-critical invariants:
 *
 *   1. best execution      -> cheapest NET price wins (fee-inclusive)
 *   2. slippage protection -> adverse fill beyond tolerance aborts (ok:false)
 *   3. venue fallback      -> reject/throw rolls to the next-best venue
 *   4. idempotency         -> a retried buy reuses the order, never double-buys
 *   5. circuit breaker     -> down / withdrawals-disabled venues are skipped
 *   6. all-venues-down     -> structured failure, never throws
 *   7. notional split      -> large order slices + aggregates fills (one venue)
 *   8. no-float precision  -> decimal strings round-trip exactly
 */
import { CryptoExecEngine } from './crypto-exec.engine';
import { SmartOrderRouter } from './smart-order-router';
import { InMemoryExchange } from './testing/in-memory-exchange';
import { parseDecimal, formatDecimal, netPrice, slippageBps } from './decimal';
import { TransactionContext } from '../transaction/transaction.saga';
import { ResolvedProfile } from '@titan/profile-schema';

function profile(): ResolvedProfile {
  return {
    id: '22222222-2222-2222-2222-222222222222', label: '101.3', family: '101', version: 1,
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
    fiatAmount: 1000, fiatCurrency: 'EUR', asset: 'BTC', chain: 'BTC',
    destWallet: 'bc1qexample', state: 'CRYPTO_PENDING',
    customerId: 'cust_1', cardToken: 'tok_1', geoCountry: 'DE',
    ...over,
  };
}

describe('CryptoExecEngine — best execution', () => {
  it('1) picks the cheapest NET price (fee-inclusive, not raw price)', async () => {
    // venueA cheaper raw price but high fee; venueB pricier raw but low fee.
    // netA = 60000 * (1+0.01) = 60600 ; netB = 60200 * (1+0.001) = 60260.2
    const a = new InMemoryExchange({ name: 'venueA', price: '60000', feeBps: 100 });
    const b = new InMemoryExchange({ name: 'venueB', price: '60200', feeBps: 10 });
    const engine = new CryptoExecEngine([a, b], { maxSlippageBps: 100 });
    const res = await engine.buy(ctx());
    expect(res.ok).toBe(true);
    expect(res.venue).toBe('venueB'); // lower NET price wins
    expect(b.placements).toBe(1);
    expect(a.placements).toBe(0);
  });

  it('2) aborts on slippage breach (executed worse than tolerance) — ok:false', async () => {
    // Quote 60000, but the fill executes at 60900 = +150 bps; tolerance 50 bps.
    const v = new InMemoryExchange({ name: 'slippy', price: '60000', feeBps: 0, fillPrice: '60900' });
    const engine = new CryptoExecEngine([v], { maxSlippageBps: 50 });
    const res = await engine.buy(ctx());
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/SLIPPAGE_EXCEEDED/);
  });

  it('2b) accepts a fill inside tolerance', async () => {
    // +20 bps fill, 50 bps tolerance -> allowed.
    const v = new InMemoryExchange({ name: 'ok', price: '60000', feeBps: 0, fillPrice: '60120' });
    const engine = new CryptoExecEngine([v], { maxSlippageBps: 50 });
    const res = await engine.buy(ctx());
    expect(res.ok).toBe(true);
    expect(res.venue).toBe('ok');
  });

  it('3) falls back to the next-best venue when the best REJECTs', async () => {
    const best = new InMemoryExchange({ name: 'best', price: '60000', feeBps: 0, reject: 'INSUFFICIENT_LIQUIDITY' });
    const next = new InMemoryExchange({ name: 'next', price: '60100', feeBps: 0 });
    const engine = new CryptoExecEngine([best, next], { maxSlippageBps: 100 });
    const res = await engine.buy(ctx());
    expect(res.ok).toBe(true);
    expect(res.venue).toBe('next');     // fell back
    expect(best.placements).toBe(1);    // best was tried
  });

  it('3b) falls back when the best venue THROWS on placeOrder', async () => {
    const best = new InMemoryExchange({ name: 'best', price: '60000', feeBps: 0, throwOnOrder: true });
    const next = new InMemoryExchange({ name: 'next', price: '60100', feeBps: 0 });
    const engine = new CryptoExecEngine([best, next], { maxSlippageBps: 100 });
    const res = await engine.buy(ctx());
    expect(res.ok).toBe(true);
    expect(res.venue).toBe('next');
  });

  it('4) IDEMPOTENT: a retried buy reuses the order and never double-buys', async () => {
    const v = new InMemoryExchange({ name: 'v', price: '60000', feeBps: 0 });
    const engine = new CryptoExecEngine([v], { maxSlippageBps: 100 });
    const c = ctx({ id: 'tx_fixed_1' });
    const r1 = await engine.buy(c);
    const r2 = await engine.buy(c); // saga retry / at-least-once redelivery
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r1.qty).toBe(r2.qty);
    expect(v.placements).toBe(1);               // exactly ONE real placement
    expect([...v.orders.keys()]).toEqual(['titan:tx_fixed_1']); // deterministic id
  });

  it('5) circuit-breaker: skips down and withdrawals-disabled venues', async () => {
    const down = new InMemoryExchange({ name: 'down', price: '59000', feeBps: 0, up: false });
    const noWd = new InMemoryExchange({ name: 'noWd', price: '59500', feeBps: 0, withdrawalsEnabled: false });
    const good = new InMemoryExchange({ name: 'good', price: '60000', feeBps: 0 });
    const engine = new CryptoExecEngine([down, noWd, good], { maxSlippageBps: 100 });
    const res = await engine.buy(ctx());
    expect(res.ok).toBe(true);
    expect(res.venue).toBe('good');     // cheaper venues skipped (unhealthy)
    expect(down.placements).toBe(0);
    expect(noWd.placements).toBe(0);
  });

  it('6) all venues unusable -> structured failure, never throws', async () => {
    const down = new InMemoryExchange({ name: 'down', price: '60000', feeBps: 0, up: false });
    const throwsHealth = new InMemoryExchange({ name: 'bad', price: '60000', feeBps: 0, throwOnHealth: true });
    const engine = new CryptoExecEngine([down, throwsHealth], { maxSlippageBps: 100 });
    const res = await engine.buy(ctx());
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('NO_HEALTHY_VENUE');
  });

  it('6b) all healthy venues REJECT -> ALL_VENUES_REJECTED (no throw)', async () => {
    const a = new InMemoryExchange({ name: 'a', price: '60000', feeBps: 0, reject: 'VENUE_REJECTED' });
    const b = new InMemoryExchange({ name: 'b', price: '60100', feeBps: 0, reject: 'VENUE_REJECTED' });
    const engine = new CryptoExecEngine([a, b], { maxSlippageBps: 100 });
    const res = await engine.buy(ctx());
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('ALL_VENUES_REJECTED');
  });

  it('7) splits large notional into child orders and aggregates fills', async () => {
    const v = new InMemoryExchange({ name: 'v', price: '50000', feeBps: 0 });
    // threshold 10k, 4 slices; notional 20k -> 4 child orders.
    const engine = new CryptoExecEngine([v], {
      maxSlippageBps: 100, splitThresholdFiat: 10_000, childSlices: 4,
    });
    const res = await engine.buy(ctx({ id: 'tx_big', fiatAmount: 20_000 }));
    expect(res.ok).toBe(true);
    expect(v.placements).toBe(4);                       // sliced
    // 20000 / 50000 = 0.4 BTC aggregated
    expect(res.qty).toBe('0.4');
    // child ids are deterministic & unique per slice
    expect([...v.orders.keys()]).toEqual([
      'titan:tx_big#0', 'titan:tx_big#1', 'titan:tx_big#2', 'titan:tx_big#3',
    ]);
  });

  it('7b) split idempotency: re-run reuses every child order', async () => {
    const v = new InMemoryExchange({ name: 'v', price: '50000', feeBps: 0 });
    const engine = new CryptoExecEngine([v], {
      maxSlippageBps: 100, splitThresholdFiat: 10_000, childSlices: 4,
    });
    const c = ctx({ id: 'tx_big2', fiatAmount: 20_000 });
    await engine.buy(c);
    await engine.buy(c);
    expect(v.placements).toBe(4); // still 4 — replays reused all children
  });

  // ---- FINDING #1: short / partial fills must NOT return ok:true with a qty
  //                  worth less fiat than the customer is charged. ----
  it('8) PARTIAL fill -> ok:false (never under-deliver against full fiat auth)', async () => {
    // 50% partial on a single-slice order: filledNotional is half the requested
    // notional, so the engine must reject rather than accept a short fill.
    const v = new InMemoryExchange({ name: 'partial', price: '60000', feeBps: 0, partialRatio: '0.5' });
    const engine = new CryptoExecEngine([v], { maxSlippageBps: 50 });
    const res = await engine.buy(ctx());
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/SHORT_FILL/);
    expect(res.qty).toBeUndefined();
  });

  it('8b) split where only the first slice fills -> ok:false (short aggregate)', async () => {
    // 20000 EUR over 4 slices @60000; only the first 5000 slice fills, the rest
    // REJECT. Aggregate is 0.0833 BTC (25%) vs 0.333 requested -> short -> reject.
    const v = new InMemoryExchange({
      name: 'dryup', price: '60000', feeBps: 0,
      rejectAfterPlacements: { count: 1, reason: 'INSUFFICIENT_LIQUIDITY' },
    });
    const engine = new CryptoExecEngine([v], {
      maxSlippageBps: 50, splitThresholdFiat: 10_000, childSlices: 4,
    });
    const res = await engine.buy(ctx({ id: 'tx_short', fiatAmount: 20_000 }));
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/SHORT_FILL/);
    expect(res.qty).toBeUndefined();
  });

  it('8c) a full fill still passes the notional reconciliation', async () => {
    const v = new InMemoryExchange({ name: 'full', price: '60000', feeBps: 0 });
    const engine = new CryptoExecEngine([v], { maxSlippageBps: 50 });
    const res = await engine.buy(ctx());
    expect(res.ok).toBe(true);
    expect(res.qty).toBeTruthy();
  });

  // ---- FINDING #2: the slippage gate must bound NET (fee-inclusive) cost,
  //                  not raw price, so a large taker fee cannot pass at 0 bps. ----
  it('9) fee-blind slippage closed: a 500 bps-fee venue on-quote is REJECTED at 50 bps tol', async () => {
    // Single venue priced exactly on quote (60000) but with a 5% taker fee. Raw
    // drift is 0 bps, but the buyer's NET cost is +500 bps -> must exceed the 50
    // bps tolerance and abort.
    const v = new InMemoryExchange({ name: 'fatfee', price: '60000', feeBps: 500 });
    const engine = new CryptoExecEngine([v], { maxSlippageBps: 50 });
    const res = await engine.buy(ctx());
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/SLIPPAGE_EXCEEDED/);
  });

  it('9b) a low-fee on-quote venue still passes the net-cost gate', async () => {
    // 10 bps fee on quote -> +10 bps net, within a 50 bps tolerance.
    const v = new InMemoryExchange({ name: 'thinfee', price: '60000', feeBps: 10 });
    const engine = new CryptoExecEngine([v], { maxSlippageBps: 50 });
    const res = await engine.buy(ctx());
    expect(res.ok).toBe(true);
  });
});

describe('SmartOrderRouter — direct surface', () => {
  it('returns the reference quote anchoring slippage (best net price)', async () => {
    const a = new InMemoryExchange({ name: 'a', price: '60000', feeBps: 100 });
    const b = new InMemoryExchange({ name: 'b', price: '60200', feeBps: 10 });
    const sor = new SmartOrderRouter([a, b]);
    const res = await sor.bestExecution({
      clientOrderId: 'co_1', asset: 'BTC', fiatAmount: 1000, fiatCurrency: 'EUR', maxSlippageBps: 100,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.referenceQuote.venue).toBe('b');
  });
});

describe('decimal — no-float money math', () => {
  it('parses/formats decimal strings exactly (round-trip)', () => {
    for (const s of ['0', '1', '60000.00', '0.00000001', '12345.678901234567']) {
      expect(formatDecimal(parseDecimal(s))).toBe(s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, ''));
    }
  });

  it('rejects non-decimal / float-y input (no Number coercion)', () => {
    expect(() => parseDecimal('1e3')).toThrow();
    expect(() => parseDecimal('NaN')).toThrow();
    expect(() => parseDecimal('0x10')).toThrow();
  });

  it('netPrice grosses up by fee in basis points (integer-exact)', () => {
    // 60000 @ 50 bps -> 60300
    expect(formatDecimal(netPrice(parseDecimal('60000'), 50))).toBe('60300');
  });

  it('slippageBps computes adverse deviation exactly', () => {
    // 60000 -> 60900 is +150 bps
    expect(slippageBps(parseDecimal('60000'), parseDecimal('60900'))).toBe(150n);
    // better-than-quote -> negative
    expect(slippageBps(parseDecimal('60000'), parseDecimal('59700'))).toBe(-50n);
  });
});
