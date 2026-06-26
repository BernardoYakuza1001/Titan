/**
 * PROJECT TITAN — Pricing wired into the live money path (slice 2).
 *
 * Proves the revenue model is honored by the REAL engines on the transaction's
 * critical path, not just in isolation:
 *
 *   - the REAL AuthEngine authorizes `fiatChargedMinor` (the headline charge),
 *     using the float-safe integer amount from the quote;
 *   - the REAL CryptoExecEngine spends `acquisitionBudgetMinor` at the venue
 *     (NOT the full charge), so the platform keeps the spread;
 *   - with NO priceQuote, both fall back to the legacy fiatAmount (backward
 *     compatible — this is why the prior 145 tests stay green).
 *
 * Money is integer minor units / decimal strings throughout — no floats.
 */
import { AuthEngine } from '../services/payment/auth-engine.service';
import { PaymentRouter, RouteStore, RouteCandidate } from '../services/payment/payment-router.service';
import {
  PaymentGatewayAdapter, AuthorizeRequest, VoidRequest, GatewayResult, MerchantRoute,
} from '../services/payment/gateway/payment-gateway.port';
import { CryptoExecEngine } from '../services/crypto-exec/crypto-exec.engine';
import { InMemoryExchange } from '../services/crypto-exec/testing/in-memory-exchange';
import { TransactionContext } from '../services/transaction/transaction.saga';
import { PricingEngine } from '../services/pricing';
import { PriceQuote } from '../services/pricing/pricing.types';
import { ResolvedProfile } from '@titan/profile-schema';

// ---- minimal real wiring doubles (record-only; no network) ----
const ROUTE: MerchantRoute = { routeId: 'route_eu_a', processor: 'adyen', merchantAccount: 'acct', mid: 'mid1' };

class RecordingGateway implements PaymentGatewayAdapter {
  readonly processor = 'adyen';
  lastAuthorize?: AuthorizeRequest;
  async authorize(req: AuthorizeRequest): Promise<GatewayResult> {
    this.lastAuthorize = req;
    return { ok: true, authCode: 'A1', networkRef: 'ref_' + req.reference };
  }
  async void(_req: VoidRequest): Promise<GatewayResult> {
    return { ok: true };
  }
}

class FixedRouteStore implements RouteStore {
  async candidatesFor(routeId: string, _currency: string): Promise<RouteCandidate[]> {
    return [{ route: { ...ROUTE, routeId }, healthy: true, successRate: 0.99, costBps: 180 }];
  }
}

function profile(): ResolvedProfile {
  return {
    id: '33333333-3333-3333-3333-333333333333', label: '101.3', family: '101', version: 1,
    signature: 'sig', resolvedFor: 'dev1', etag: 'e1', expiresAt: '2999-01-01T00:00:00.000Z',
    dimensions: {
      processorRoute: 'route_eu_a',
      approvalPolicy: { type: 'OOB_OTP', length: 6, preAuth: true, stepUpTriggers: [] },
      captureMethods: { card: ['EMV'], wallet: ['QR'] },
      kycLevel: 'FULL_LIVENESS', assetSet: ['BTC'],
      walletValidation: { enforceChecksum: true, screenDestination: true, blockMixers: true },
      riskTier: 'tier_std', txCaps: { perTxn: 1_000_000, daily: 3_000_000, currency: 'EUR' },
      settlementRoute: 'settle_eu', compliancePack: 'EU_MiCA_TFR', deliveryStrategy: 'BUY_THEN_SEND',
    },
  };
}

function ctx(over: Partial<TransactionContext> = {}): TransactionContext {
  return {
    id: over.id ?? 'tx_wire_' + Math.random().toString(36).slice(2),
    deviceId: 'dev1', profile: profile(),
    fiatAmount: 150, fiatCurrency: 'EUR', asset: 'BTC', chain: 'bitcoin',
    destWallet: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', state: 'CRYPTO_PENDING',
    customerId: 'cust_1', cardToken: 'tok_1', geoCountry: 'DE', ...over,
  };
}

function quoteFor(fiatAmount: number): PriceQuote {
  const pricing = new PricingEngine({ markupBps: 150, minMarginMinor: 50n });
  const q = pricing.quote({
    fiatAmount, fiatCurrency: 'EUR', acquirerCostBps: 180, exchangeTakerBps: 20, gasEstimateMinor: 5n,
  });
  if (!q.ok) throw new Error('test quote should be ok');
  return q;
}

describe('AuthEngine honors the price quote', () => {
  it('authorizes the headline CHARGE (fiatChargedMinor), not a re-derived float', async () => {
    const gateway = new RecordingGateway();
    const router = new PaymentRouter(new FixedRouteStore(), new Map([['adyen', gateway]]));
    const auth = new AuthEngine(router, {
      put: async () => {}, get: async () => null,
    });
    const q = quoteFor(150); // fiatChargedMinor = 15000

    const res = await auth.authorize(ctx({ priceQuote: q }));

    expect(res.ok).toBe(true);
    expect(gateway.lastAuthorize?.amountMinor).toBe(15_000); // exact charge from the quote
  });

  it('falls back to the legacy fiatAmount conversion when unpriced', async () => {
    const gateway = new RecordingGateway();
    const router = new PaymentRouter(new FixedRouteStore(), new Map([['adyen', gateway]]));
    const auth = new AuthEngine(router, { put: async () => {}, get: async () => null });

    await auth.authorize(ctx()); // no priceQuote

    expect(gateway.lastAuthorize?.amountMinor).toBe(15_000); // 150.00 EUR -> 15000 minor
  });
});

describe('CryptoExecEngine spends the budget, not the charge', () => {
  it('priced txn: the venue order is for the BUDGET (144.70), not the charge (150)', async () => {
    const q = quoteFor(150); // budget = 14470 minor = 144.70 EUR
    const venue = new InMemoryExchange({ name: 'venueA', price: '60000', feeBps: 20 });
    const engine = new CryptoExecEngine([venue], { maxSlippageBps: 50 });

    const buy = await engine.buy(ctx({ priceQuote: q }));

    expect(buy.ok).toBe(true);
    const order = [...venue.orders.values()][0];
    expect(order.req.fiatAmount).toBe(144.70);
    expect(order.req.fiatAmount).toBeLessThan(150);
  });

  it('unpriced txn: the venue order is for the full fiatAmount (legacy behavior)', async () => {
    const venue = new InMemoryExchange({ name: 'venueA', price: '60000', feeBps: 20 });
    const engine = new CryptoExecEngine([venue], { maxSlippageBps: 50 });

    const buy = await engine.buy(ctx()); // no priceQuote

    expect(buy.ok).toBe(true);
    const order = [...venue.orders.values()][0];
    expect(order.req.fiatAmount).toBe(150);
  });
});
