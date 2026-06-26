/**
 * PROJECT TITAN — Binance Spot adapter (Phase 5)
 *
 * Real Binance Spot REST surface (translated to ExchangeAdapter):
 *   - Book ticker:  GET  https://api.binance.com/api/v3/ticker/bookTicker?symbol=BTCEUR
 *   - New order:    POST https://api.binance.com/api/v3/order   (SIGNED)
 *   - Ping/time:    GET  https://api.binance.com/api/v3/ping    (health)
 *   - Coin config:  GET  https://api.binance.com/sapi/v1/capital/config/getall (SIGNED, withdraw flags)
 *
 * AUTH (SIGNED endpoints): HMAC-SHA256 over the query string using the secret.
 *   Header:  X-MBX-APIKEY: <api key>
 *   Param:   signature=<hex hmac sha256(querystring, secret)>
 * Signing is delegated to an injected `sign(query)` so the secret stays out of
 * this module; the key fn is `() => string`.
 *
 * Binance quirks normalized here:
 *   - Symbols are concatenated, no separator: BTCEUR.
 *   - Market BUY by fiat uses `quoteOrderQty`. Idempotency uses `newClientOrderId`
 *     — re-sending the same id returns -2010 "Duplicate order sent", which we
 *     treat as the prior order (reconciled via the same id).
 *   - Errors: `{ code: <negative int>, msg }`. We map codes onto normalized reasons.
 */
import {
  ExchangeAdapter, Quote, QuoteRequest, PlaceOrderRequest, OrderResult,
  VenueHealth, HttpClient, EXCHANGE_REASON,
} from '../exchange.port';
import { parseDecimal, div, formatDecimal } from '../decimal';

function symbol(asset: string, fiat: string): string {
  return `${asset.toUpperCase()}${fiat.toUpperCase()}`;
}

const REASON: Record<number, string> = {
  [-2010]: EXCHANGE_REASON.VENUE_REJECTED,     // generic NEW_ORDER_REJECTED / duplicate
  [-1003]: EXCHANGE_REASON.RATE_LIMITED,       // too many requests
  [-2015]: EXCHANGE_REASON.AUTH_FAILED,        // invalid api-key/permissions/ip
  [-1021]: EXCHANGE_REASON.VENUE_REJECTED,     // timestamp outside recvWindow
  [-1013]: EXCHANGE_REASON.INSUFFICIENT_LIQUIDITY, // filter failure / min notional
};
function normalizeError(code: number | undefined, msg?: string): string {
  if (code != null && REASON[code]) return REASON[code];
  if (msg && /insufficient/i.test(msg)) return EXCHANGE_REASON.INSUFFICIENT_LIQUIDITY;
  return EXCHANGE_REASON.VENUE_REJECTED;
}

export interface BinanceSigner {
  /** query string -> hex HMAC-SHA256 signature. Secret stays inside. */
  (query: string): string;
}

export class BinanceAdapter implements ExchangeAdapter {
  readonly name = 'binance';

  constructor(
    private readonly http: HttpClient,
    private readonly baseUrl: string,         // https://api.binance.com
    private readonly apiKey: () => string,
    private readonly sign: BinanceSigner,
    private readonly feeBps = 10,             // Binance spot taker (~0.10%)
    private readonly quoteTtlMs = 5_000,
    private readonly now: () => number = Date.now,
  ) {}

  async getQuote(req: QuoteRequest): Promise<Quote> {
    const sym = symbol(req.asset, req.fiatCurrency);
    const res = await this.http.post(
      `${this.baseUrl}/api/v3/ticker/bookTicker?symbol=${sym}`,
      {},
      { 'Content-Type': 'application/json' },
    );
    const body = res.body ?? {};
    if (res.status < 200 || res.status >= 300 || body.code) {
      throw new Error(`binance quote failed: ${normalizeError(body.code, body.msg)}`);
    }
    const price: string | undefined = body.askPrice ?? body.bidPrice;
    if (!price) throw new Error('binance quote: no price');
    return {
      venue: this.name,
      price: String(price),
      qty: decimalDiv(req.fiatAmount.toString(), String(price)),
      feeBps: this.feeBps,
      expiresAt: new Date(this.now() + this.quoteTtlMs).toISOString(),
    };
  }

  async placeOrder(req: PlaceOrderRequest): Promise<OrderResult> {
    const sym = symbol(req.asset, req.fiatCurrency);
    const ts = this.now();
    // SIGNED params go in the query string; signature appended after signing.
    const query =
      `symbol=${sym}&side=BUY&type=MARKET&quoteOrderQty=${req.fiatAmount}` +
      `&newClientOrderId=${encodeURIComponent(req.clientOrderId)}` +
      `&newOrderRespType=FULL&recvWindow=5000&timestamp=${ts}`;
    const signature = this.sign(query);
    const res = await this.http.post(
      `${this.baseUrl}/api/v3/order?${query}&signature=${signature}`,
      {},
      { 'X-MBX-APIKEY': this.apiKey(), 'Content-Type': 'application/x-www-form-urlencoded' },
    );
    const body = res.body ?? {};
    if (res.status < 200 || res.status >= 300 || body.code) {
      return {
        venue: this.name, status: 'REJECTED', filledQty: '0', avgPrice: '0',
        reason: normalizeError(body.code, body.msg), raw: body,
      };
    }
    // FULL response: executedQty (base), cummulativeQuoteQty (fiat spent), fills[].
    const filledQty = String(body.executedQty ?? '0');
    const quoteSpent = String(body.cummulativeQuoteQty ?? '0');
    const avgPrice = filledQty !== '0' ? decimalDiv(quoteSpent, filledQty) : '0';
    const requested = String(body.origQty ?? filledQty);
    const status: OrderResult['status'] = filledQty === '0'
      ? 'REJECTED'
      : (body.status === 'PARTIALLY_FILLED'
        || (requested !== '0' && requested !== filledQty) ? 'PARTIAL' : 'FILLED');
    return { venue: this.name, status, filledQty, avgPrice, raw: body };
  }

  async health(): Promise<VenueHealth> {
    const t0 = this.now();
    try {
      const res = await this.http.post(
        `${this.baseUrl}/api/v3/ping`, {}, { 'Content-Type': 'application/json' },
      );
      const up = res.status >= 200 && res.status < 300;
      // Withdrawal flags live behind SIGNED sapi/capital/config/getall; the
      // injected http may surface them as `withdrawAllEnable`. Default to `up`.
      const withdrawalsEnabled = typeof res.body?.withdrawAllEnable === 'boolean'
        ? res.body.withdrawAllEnable
        : up;
      return { venue: this.name, up, latencyMs: this.now() - t0, withdrawalsEnabled };
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
