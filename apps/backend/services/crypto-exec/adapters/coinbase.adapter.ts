/**
 * PROJECT TITAN — Coinbase Advanced Trade adapter (Phase 5)
 *
 * Real Coinbase Advanced Trade REST surface (translated to ExchangeAdapter):
 *   - Best bid/ask:  GET  https://api.coinbase.com/api/v3/brokerage/best_bid_ask?product_ids=BTC-EUR
 *   - Create order:  POST https://api.coinbase.com/api/v3/brokerage/orders
 *   - Order status:  GET  https://api.coinbase.com/api/v3/brokerage/orders/historical/{order_id}
 *   - Server time:   GET  https://api.coinbase.com/api/v3/brokerage/time   (health probe)
 *
 * AUTH: Coinbase Advanced Trade uses a JWT (ES256) bearer per request, minted
 *   from the API key name + EC private key. Minting is delegated to an injected
 *   `mintJwt()` so the EC key never enters this module:
 *     Authorization: Bearer <jwt>
 *
 * Coinbase quirks normalized here:
 *   - Product ids are hyphenated: BTC-EUR.
 *   - Market BUY uses `quote_size` (spend N fiat). `client_order_id` is the
 *     idempotency key — replaying it returns the existing order (no double buy).
 *   - Errors arrive as `{ error, error_details, ... }` (and `success:false` on
 *     create_order). We map those onto normalized reasons.
 */
import {
  ExchangeAdapter, Quote, QuoteRequest, PlaceOrderRequest, OrderResult,
  VenueHealth, HttpClient, EXCHANGE_REASON,
} from '../exchange.port';
import { parseDecimal, div, formatDecimal } from '../decimal';

function product(asset: string, fiat: string): string {
  return `${asset.toUpperCase()}-${fiat.toUpperCase()}`;
}

const REASON: Record<string, string> = {
  INSUFFICIENT_FUND: EXCHANGE_REASON.INSUFFICIENT_LIQUIDITY,
  INSUFFICIENT_FUNDS: EXCHANGE_REASON.INSUFFICIENT_LIQUIDITY,
  PREVIEW_INSUFFICIENT_FUND: EXCHANGE_REASON.INSUFFICIENT_LIQUIDITY,
  RATE_LIMIT_EXCEEDED: EXCHANGE_REASON.RATE_LIMITED,
  UNAUTHORIZED: EXCHANGE_REASON.AUTH_FAILED,
  PERMISSION_DENIED: EXCHANGE_REASON.AUTH_FAILED,
  SERVICE_UNAVAILABLE: EXCHANGE_REASON.VENUE_UNAVAILABLE,
};
function normalizeError(code: string | undefined): string {
  return (code && REASON[code]) || EXCHANGE_REASON.VENUE_REJECTED;
}

export interface CoinbaseJwtMinter {
  /** method + request path -> short-lived ES256 JWT. EC key stays inside. */
  (method: string, requestPath: string): string;
}

export class CoinbaseAdapter implements ExchangeAdapter {
  readonly name = 'coinbase';

  constructor(
    private readonly http: HttpClient,
    private readonly baseUrl: string,          // https://api.coinbase.com
    private readonly mintJwt: CoinbaseJwtMinter,
    private readonly feeBps = 60,              // Advanced Trade taker (~0.60% retail)
    private readonly quoteTtlMs = 5_000,
    private readonly now: () => number = Date.now,
  ) {}

  async getQuote(req: QuoteRequest): Promise<Quote> {
    const pid = product(req.asset, req.fiatCurrency);
    const path = `/api/v3/brokerage/best_bid_ask?product_ids=${pid}`;
    const res = await this.http.post(
      `${this.baseUrl}${path}`,
      {},
      { Authorization: `Bearer ${this.mintJwt('GET', path)}`, 'Content-Type': 'application/json' },
    );
    const body = res.body ?? {};
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`coinbase quote failed: ${normalizeError(body.error)}`);
    }
    const pb = (body.pricebooks ?? [])[0] ?? {};
    const price: string | undefined = pb.asks?.[0]?.price ?? pb.bids?.[0]?.price;
    if (!price) throw new Error('coinbase quote: no price');
    return {
      venue: this.name,
      price: String(price),
      qty: decimalDiv(req.fiatAmount.toString(), String(price)),
      feeBps: this.feeBps,
      expiresAt: new Date(this.now() + this.quoteTtlMs).toISOString(),
    };
  }

  async placeOrder(req: PlaceOrderRequest): Promise<OrderResult> {
    const path = '/api/v3/brokerage/orders';
    const res = await this.http.post(
      `${this.baseUrl}${path}`,
      {
        client_order_id: req.clientOrderId,           // idempotency key
        product_id: product(req.asset, req.fiatCurrency),
        side: 'BUY',
        order_configuration: {
          // Spend a fixed fiat amount at market.
          market_market_ioc: { quote_size: req.fiatAmount.toString() },
        },
      },
      { Authorization: `Bearer ${this.mintJwt('POST', path)}`, 'Content-Type': 'application/json' },
    );
    const body = res.body ?? {};
    const success = res.status >= 200 && res.status < 300 && body.success === true;
    if (!success) {
      const code = body.error_response?.error ?? body.error;
      return {
        venue: this.name, status: 'REJECTED', filledQty: '0', avgPrice: '0',
        reason: normalizeError(code), raw: body,
      };
    }
    // success_response carries fills summary on Advanced Trade.
    const sr = body.success_response ?? {};
    const filledQty = String(sr.filled_size ?? body.filled_size ?? '0');
    const filledValue = String(sr.filled_value ?? body.filled_value ?? '0');
    const avgPrice = filledQty !== '0' ? decimalDiv(filledValue, filledQty) : '0';
    const requested = String(sr.base_size ?? filledQty);
    const status: OrderResult['status'] = filledQty === '0'
      ? 'REJECTED'
      : (requested !== '0' && requested !== filledQty ? 'PARTIAL' : 'FILLED');
    return { venue: this.name, status, filledQty, avgPrice, raw: body };
  }

  async health(): Promise<VenueHealth> {
    const t0 = this.now();
    const path = '/api/v3/brokerage/time';
    try {
      const res = await this.http.post(
        `${this.baseUrl}${path}`,
        {},
        { Authorization: `Bearer ${this.mintJwt('GET', path)}`, 'Content-Type': 'application/json' },
      );
      const up = res.status >= 200 && res.status < 300;
      return { venue: this.name, up, latencyMs: this.now() - t0, withdrawalsEnabled: up };
    } catch {
      return { venue: this.name, up: false, latencyMs: this.now() - t0, withdrawalsEnabled: false };
    }
  }
}

function decimalDiv(a: string, b: string): string {
  const sb = parseDecimal(b);
  if (sb === 0n) return '0';
  return formatDecimal(div(parseDecimal(a), sb));
}
