/**
 * PROJECT TITAN — Pricing Engine unit proof (the revenue model).
 *
 * Proves the property the whole business rests on: the customer is charged a
 * headline amount, the venue only ever spends the ACQUISITION BUDGET, and the
 * difference (after funding acquirer + taker + gas + FX) is the platform's
 * margin — so the on-ramp is profitable on every transaction instead of losing
 * the fee stack on every transaction (the structural leak in the current saga).
 *
 *   - made-whole identity: budget + Σfees === charged, EXACTLY (integer minor units);
 *   - every pass-through cost is funded by the customer, not eaten;
 *   - the margin floor protects tiny tickets; uneconomic tickets are refused;
 *   - money conversion is float-SAFE (no `* 10**n` IEEE-754 error);
 *   - reconciliation detects margin compression / venue overspend;
 *   - integration: the REAL CryptoExecEngine, fed the budget, spends the budget
 *     (not the charge), so the platform provably keeps the spread.
 *
 * Money is integer minor units / decimal strings throughout — no floats.
 */
import {
  PricingEngine, DEFAULT_PRICING_POLICY, RISK_TIER_MARKUP_BPS, policyForProfile,
  majorToMinor, minorToMajor, minorExponent,
} from '../services/pricing';
import { PriceQuote } from '../services/pricing/pricing.types';
import { CryptoExecEngine } from '../services/crypto-exec/crypto-exec.engine';
import { InMemoryExchange } from '../services/crypto-exec/testing/in-memory-exchange';
import { TransactionContext } from '../services/transaction/transaction.saga';
import { parseDecimal, div, formatDecimal } from '../services/crypto-exec/decimal';
import { ResolvedProfile } from '@titan/profile-schema';

function profile(over: Partial<ResolvedProfile['dimensions']> = {}): ResolvedProfile {
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
      ...over,
    },
  };
}

/** Sum of the five fee lines — used to assert the made-whole identity. */
function feeSum(q: PriceQuote): bigint {
  return q.acquirerCostMinor + q.fxSpreadMinor + q.takerCostMinor + q.gasMinor + q.markupMinor;
}

describe('majorToMinor — float-safe money conversion', () => {
  it('converts common values exactly (no IEEE-754 error)', () => {
    expect(majorToMinor(150, 2)).toBe(15_000n);
    expect(majorToMinor(150.0, 2)).toBe(15_000n);
    expect(majorToMinor(0.1, 2)).toBe(10n);     // the classic float trap
    expect(majorToMinor(1.1, 2)).toBe(110n);
    expect(majorToMinor(0.3, 2)).toBe(30n);
    expect(majorToMinor(99.99, 2)).toBe(9_999n);
    expect(majorToMinor(1000, 0)).toBe(1_000n); // JPY-style zero-decimal
  });

  it('refuses over-precise amounts rather than silently rounding (the toMinorUnits bug)', () => {
    // `Math.round(1.005 * 100)` === 100 (wrong, drops a cent); we reject instead.
    expect(() => majorToMinor(1.005, 2)).toThrow(/minor digits/);
    expect(() => majorToMinor(150.001, 2)).toThrow(/minor digits/);
  });

  it('rejects negative / non-finite amounts', () => {
    expect(() => majorToMinor(-1, 2)).toThrow(/invalid money/);
    expect(() => majorToMinor(NaN, 2)).toThrow(/invalid money/);
    expect(() => majorToMinor(Infinity, 2)).toThrow(/invalid money/);
  });

  it('minorToMajor round-trips', () => {
    expect(minorToMajor(15_000n, 2)).toBe('150.00');
    expect(minorToMajor(14_470n, 2)).toBe('144.70');
    expect(minorToMajor(1_000n, 0)).toBe('1000');
    expect(minorExponent('JPY')).toBe(0);
    expect(minorExponent('eur')).toBe(2);
  });
});

describe('PricingEngine.quote — the made-whole property', () => {
  const engine = new PricingEngine({ markupBps: 150, minMarginMinor: 50n });

  it('splits the charge so budget + Σfees === charged, EXACTLY', () => {
    const r = engine.quote({
      fiatAmount: 150, fiatCurrency: 'EUR',
      acquirerCostBps: 180, exchangeTakerBps: 20, gasEstimateMinor: 5n,
    });
    expect(r.ok).toBe(true);
    const q = r as PriceQuote;

    // charged = 150.00 EUR = 15000 minor
    expect(q.fiatChargedMinor).toBe(15_000n);
    // acquirer 180bps of 15000 = 270 ; fx 0 ; markup 150bps of 15000 = 225 (> 50 floor)
    expect(q.acquirerCostMinor).toBe(270n);
    expect(q.fxSpreadMinor).toBe(0n);
    expect(q.markupMinor).toBe(225n);
    // preBudget = 15000 - 270 - 0 - 225 = 14505 ; taker 20bps of 14505 = 29.01 -> ceil 30
    expect(q.takerCostMinor).toBe(30n);
    expect(q.gasMinor).toBe(5n);
    // budget = 14505 - 30 - 5 = 14470
    expect(q.acquisitionBudgetMinor).toBe(14_470n);

    // THE INVARIANT: nothing is created or lost.
    expect(q.acquisitionBudgetMinor + q.totalFeeMinor).toBe(q.fiatChargedMinor);
    expect(q.totalFeeMinor).toBe(feeSum(q));
    // profit line is the markup only — pass-throughs are recovered costs, not profit.
    expect(q.projectedSpreadMinor).toBe(225n);
  });

  it('passes EVERY rail cost through to the customer (none eaten)', () => {
    const base = { fiatAmount: 150, fiatCurrency: 'EUR', exchangeTakerBps: 0, gasEstimateMinor: 0n };
    const cheap = engine.quote({ ...base, acquirerCostBps: 0 }) as PriceQuote;
    const dear = engine.quote({ ...base, acquirerCostBps: 300 }) as PriceQuote;
    // A pricier acquirer shrinks the budget by exactly its cost — the platform's
    // margin is unchanged (the customer funds the cost, not us).
    expect(cheap.markupMinor).toBe(dear.markupMinor);
    expect(cheap.acquisitionBudgetMinor - dear.acquisitionBudgetMinor).toBe(dear.acquirerCostMinor);
  });

  it('FX spread and gas each reduce the budget by exactly their amount', () => {
    const noFx = engine.quote({
      fiatAmount: 200, fiatCurrency: 'EUR', acquirerCostBps: 0, exchangeTakerBps: 0, gasEstimateMinor: 0n,
    }) as PriceQuote;
    const withFx = engine.quote({
      fiatAmount: 200, fiatCurrency: 'EUR', acquirerCostBps: 0, exchangeTakerBps: 0,
      gasEstimateMinor: 0n, fxSpreadBps: 100,
    }) as PriceQuote;
    expect(withFx.fxSpreadMinor).toBe(200n); // 100bps of 20000
    expect(noFx.acquisitionBudgetMinor - withFx.acquisitionBudgetMinor).toBe(200n);

    const withGas = engine.quote({
      fiatAmount: 200, fiatCurrency: 'EUR', acquirerCostBps: 0, exchangeTakerBps: 0, gasEstimateMinor: 35n,
    }) as PriceQuote;
    expect(withGas.gasMinor).toBe(35n);
    expect(noFx.acquisitionBudgetMinor - withGas.acquisitionBudgetMinor).toBe(35n);
  });

  it('all fees round UP (conservative) — the platform is never short a fraction', () => {
    // 33 EUR = 3300 minor; acquirer 175bps = 57.75 -> ceil 58 (not 57).
    const q = engine.quote({
      fiatAmount: 33, fiatCurrency: 'EUR', acquirerCostBps: 175, exchangeTakerBps: 0, gasEstimateMinor: 0n,
    }) as PriceQuote;
    expect(q.acquirerCostMinor).toBe(58n);
    // identity still holds exactly under rounding — the budget absorbs it.
    expect(q.acquisitionBudgetMinor + q.totalFeeMinor).toBe(q.fiatChargedMinor);
  });
});

describe('PricingEngine.quote — margin floor & uneconomic tickets', () => {
  const engine = new PricingEngine({ markupBps: 150, minMarginMinor: 50n });

  it('applies the absolute margin floor on small tickets', () => {
    // 10 EUR: 150bps = 15 minor, which is below the 50-minor floor -> floor wins.
    const q = engine.quote({
      fiatAmount: 10, fiatCurrency: 'EUR', acquirerCostBps: 0, exchangeTakerBps: 0, gasEstimateMinor: 0n,
    }) as PriceQuote;
    expect(q.markupMinor).toBe(50n);
    expect(q.projectedSpreadMinor).toBe(50n);
  });

  it('REFUSES a ticket whose costs exceed the charge (declines at a loss-free point)', () => {
    // 1 EUR charge (100 minor): a 60% acquirer (60 minor) + the 50-minor floor
    // margin leave no budget (100 - 60 - 50 < 0) -> refuse rather than transact.
    const r = engine.quote({
      fiatAmount: 1, fiatCurrency: 'EUR', acquirerCostBps: 6000, exchangeTakerBps: 0, gasEstimateMinor: 0n,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('TICKET_TOO_SMALL');
  });

  it('REFUSES a ticket smaller than the margin floor itself', () => {
    // 0.40 EUR (40 minor) < 50-minor floor margin -> cannot be priced profitably.
    const r = engine.quote({
      fiatAmount: 0.40, fiatCurrency: 'EUR', acquirerCostBps: 0, exchangeTakerBps: 0, gasEstimateMinor: 0n,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('TICKET_TOO_SMALL');
  });

  it('REFUSES when gas alone eats the remaining budget', () => {
    const r = engine.quote({
      fiatAmount: 1, fiatCurrency: 'EUR', acquirerCostBps: 0, exchangeTakerBps: 0, gasEstimateMinor: 200n,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('TICKET_TOO_SMALL');
  });

  it('rejects invalid amounts as INVALID_AMOUNT, not TICKET_TOO_SMALL', () => {
    const r = engine.quote({
      fiatAmount: 1.005, fiatCurrency: 'EUR', acquirerCostBps: 0, exchangeTakerBps: 0, gasEstimateMinor: 0n,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('INVALID_AMOUNT');
  });
});

describe('policyForProfile — risk-tier pricing defaults', () => {
  it('prices higher-control tiers higher and never prices lockdown', () => {
    expect(policyForProfile(profile({ riskTier: 'tier_low' })).markupBps).toBe(RISK_TIER_MARKUP_BPS.tier_low);
    expect(policyForProfile(profile({ riskTier: 'tier_high_controls' })).markupBps).toBe(250);
    expect(policyForProfile(profile({ riskTier: 'tier_lockdown' })).markupBps).toBe(0);
    // unknown tier falls back to the default markup
    expect(policyForProfile(profile({ riskTier: 'tier_unknown' })).markupBps).toBe(DEFAULT_PRICING_POLICY.markupBps);
  });
});

describe('PricingEngine.reconcile — realized margin vs the quote', () => {
  const engine = new PricingEngine({ markupBps: 150, minMarginMinor: 50n });
  const q = engine.quote({
    fiatAmount: 150, fiatCurrency: 'EUR', acquirerCostBps: 180, exchangeTakerBps: 20, gasEstimateMinor: 5n,
  }) as PriceQuote; // budget 14470, markup 225, taker 30, gas 5, acquirer 270

  it('fee-on-top venue (spent = budget + taker): realized == projected markup, no overspend', () => {
    const r = engine.reconcile(q, { actualSpentMinor: q.acquisitionBudgetMinor + q.takerCostMinor });
    expect(r.realizedSpreadMinor).toBe(225n);
    expect(r.varianceMinor).toBe(0n);
    expect(r.marginIntact).toBe(true);
    expect(r.overspend).toBe(false);
  });

  it('fee-inclusive venue (spent = budget): realized exceeds projected (positive variance)', () => {
    const r = engine.reconcile(q, { actualSpentMinor: q.acquisitionBudgetMinor });
    expect(r.realizedSpreadMinor).toBe(225n + 30n); // kept the reserved taker too
    expect(r.varianceMinor).toBe(30n);
    expect(r.marginIntact).toBe(true);
    expect(r.overspend).toBe(false);
  });

  it('genuine slippage beyond budget+taker trips overspend and can break the floor', () => {
    // venue spent 200 minor more than the budget+taker we reserved.
    const slipped = q.acquisitionBudgetMinor + q.takerCostMinor + 200n;
    const r = engine.reconcile(q, { actualSpentMinor: slipped });
    expect(r.overspend).toBe(true);
    expect(r.realizedSpreadMinor).toBe(25n);          // 225 - 200
    expect(r.varianceMinor).toBe(-200n);              // margin compression
    expect(r.marginIntact).toBe(false);               // below the 50-minor floor
  });

  it('a gas spike above the estimate compresses realized margin', () => {
    const r = engine.reconcile(q, {
      actualSpentMinor: q.acquisitionBudgetMinor + q.takerCostMinor,
      actualGasMinor: q.gasMinor + 100n,
    });
    expect(r.realizedSpreadMinor).toBe(125n); // 225 - 100
    expect(r.varianceMinor).toBe(-100n);
  });
});

describe('integration: pricing + the REAL CryptoExecEngine close the leak', () => {
  function ctx(fiatAmount: number, over: Partial<TransactionContext> = {}): TransactionContext {
    return {
      id: over.id ?? 'tx_price_' + fiatAmount, deviceId: 'dev1', profile: profile(),
      fiatAmount, fiatCurrency: 'EUR', asset: 'BTC', chain: 'bitcoin',
      destWallet: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', state: 'CRYPTO_PENDING',
      customerId: 'cust_1', cardToken: 'tok_1', geoCountry: 'DE', ...over,
    };
  }

  it('the venue spends the BUDGET, not the charge — so the platform keeps the spread', async () => {
    const pricing = new PricingEngine({ markupBps: 150, minMarginMinor: 50n });

    // The acquirer/taker inputs would come from the chosen route + winning quote.
    const q = pricing.quote({
      fiatAmount: 150, fiatCurrency: 'EUR', acquirerCostBps: 180, exchangeTakerBps: 20, gasEstimateMinor: 5n,
    }) as PriceQuote;
    expect(q.acquisitionBudgetMinor).toBe(14_470n); // 144.70 EUR

    // Saga hands the BUDGET (not the 150 charge) to the exec engine.
    const budgetMajor = Number(minorToMajor(q.acquisitionBudgetMinor, q.exponent)); // 144.70
    const venue = new InMemoryExchange({ name: 'venueA', price: '60000', feeBps: 20 });
    const engine = new CryptoExecEngine([venue], { maxSlippageBps: 50 });

    const buy = await engine.buy(ctx(budgetMajor));
    expect(buy.ok).toBe(true);
    expect(venue.placements).toBe(1);

    // The venue order was for the BUDGET, never the headline charge.
    const order = [...venue.orders.values()][0];
    expect(order.req.fiatAmount).toBe(144.70);
    expect(order.req.fiatAmount).toBeLessThan(150);

    // Delivered qty corresponds to the budget (budget / price), not the charge.
    const expectedQty = formatDecimal(div(parseDecimal('144.70'), parseDecimal('60000')));
    expect(buy.qty).toBe(expectedQty);

    // Reconcile against the actual venue spend: the platform keeps >= the markup.
    const spentMinor = majorToMinor(order.req.fiatAmount, q.exponent);
    const rec = pricing.reconcile(q, { actualSpentMinor: spentMinor });
    expect(rec.marginIntact).toBe(true);
    expect(rec.realizedSpreadMinor).toBeGreaterThanOrEqual(q.projectedSpreadMinor);

    // Contrast with TODAY's behavior: spending the full 150 charge would leave
    // the platform with nothing to cover acquirer + taker + gas (the structural loss).
    expect(q.fiatChargedMinor - spentMinor).toBe(q.totalFeeMinor);
    expect(q.fiatChargedMinor - spentMinor).toBeGreaterThan(0n);
  });
});
