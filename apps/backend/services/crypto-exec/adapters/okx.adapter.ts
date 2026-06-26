/**
 * PROJECT TITAN — OKX Spot adapter (Phase 5)
 *
 * Real OKX V5 REST surface (translated to ExchangeAdapter):
 *   - Ticker:        GET  https://www.okx.com/api/v5/market/ticker?instId=BTC-EUR
 *   - Place order:   POST https://www.okx.com/api/v5/trade/order   (SIGNED)
 *   - System status: GET  https://www.okx.com/api/v5/system/status (health)
 *   - Currencies:    GET  https://www.okx.com/api/v5/asset/currencies (SIGNED, canWd flag)
 *
 * AUTH (private endpoints): OKX signs with
 *   OK-ACCESS-KEY:        <api key>
 *   OK-ACCESS-PASSPHRASE: <passphrase>
 *   OK-ACCESS-TIMESTAMP:  <ISO-8601 ms>
 *   OK-ACCESS-SIGN:       base64( HMAC-SHA256( timestamp + method + path + body, secret ) )
 * Signing is delegated to an injected `sign()` (secret + passphrase stay inside).
 *
 * OKX quirks normalized here:
 *   - Instrument ids are hyphenated: BTC-EUR.
 *   - Every response is `{ code:"0", msg, data:[...] }`; `code !== "0"` is a
 *     failure even on HTTP 200. Per-order errors appear in `data[0].sCode`.
 *   - Market BUY by fiat uses `tgtCcy:"quote_ccy"` + `sz:<fiat>`. Idempotency is
 *     `clOrdId` — replaying it returns the existing order (no double buy).
 */
import {
  ExchangeAdapter, Quote, QuoteRequest, PlaceOrderRequest, OrderResult,
  VenueHealth, HttpClient, EXCHANGE_REASON,
} from '../exchange.port';
import { parseDecimal, div, formatDecimal } from '../decimal';

function instId(asset: string, fiat: string): string {
  return `${asset.toUpperCase()}-${fiat.toUpperCase()}`;
}

// OKX sCode (order) / code (request) -> normalized reason.
const REASON: Record<string, string> = {
  '51008': EXCHANGE_REASON.INSUFFICIENT_LIQUIDITY, // insufficient balance
  '51120': EXCHANGE_REASON.INSUFFICIENT_LIQUIDITY, // below min size
  '50011': EXCHANGE_REASON.RATE_LIMITED,           // too many requests
  '50113': EXCHANGE_REASON.AUTH_FAILED,            // invalid signature
  '50114': EXCHANGE_REASON.AUTH_FAILED,            // invalid passphrase
  '51000': EXCHANGE_REASON.VENUE_REJECTED,         // parameter error
};
function normalizeError(code: string | undefined): string {
  return (code && REASON[code]) || EXCHANGE_REASON.VENUE_REJECTED;
}

export interface OkxSigner {
  /** timestamp+method+path+body -> base64 OK-ACCESS-SIGN. Returns full header set. */
  (timestamp: string, method: string, path: string, body: string): {
    sign: string;
    passphrase: string;
  };
}

export class OkxAdapter implements ExchangeAdapter {
  readonly name = 'okx';

  constructor(
    private readonly http: HttpClient,
    private readonly baseUrl: string,         // https://www.okx.com
    private readonly apiKey: () => string,
    private readonly sign: OkxSigner,
    private readonly feeBps = 10,             // OKX spot taker (~0.10%)
    private readonly quoteTtlMs = 5_000,
    private readonly now: () => number = Date.now,
  ) {}

  async getQuote(req: QuoteRequest): Promise<Quote> {
    const inst = instId(req.asset, req.fiatCurrency);
    const res = await this.http.post(
      `${this.baseUrl}/api/v5/market/ticker?instId=${inst}`,
      {},
      { 'Content-Type': 'application/json' },
    );
    const body = res.body ?? {};
    if (res.status < 200 || res.status >= 300 || body.code !== '0') {
      throw new Error(`okx quote failed: ${normalizeError(body.code)}`);
    }
    const d: any = (body.data ?? [])[0] ?? {};
    const price: string | undefined = d.askPx ?? d.last;
    if (!price) throw new Error('okx quote: no price');
    return {
      venue: this.name,
      price: String(price),
      qty: decimalDiv(req.fiatAmount.toString(), String(price)),
      feeBps: this.feeBps,
      expiresAt: new Date(this.now() + this.quoteTtlMs).toISOString(),
    };
  }

  async placeOrder(req: PlaceOrderRequest): Promise<OrderResult> {
    const path = '/api/v5/trade/order';
    const timestamp = new Date(this.now()).toISOString();
    const payload = {
      instId: instId(req.asset, req.fiatCurrency),
      tdMode: 'cash',
      side: 'buy',
      ordType: 'market',
      tgtCcy: 'quote_ccy',                  // size is denominated in fiat (quote)
      sz: req.fiatAmount.toString(),
      clOrdId: req.clientOrderId,           // idempotency key
    };
    const bodyStr = JSON.stringify(payload);
    const { sign, passphrase } = this.sign(timestamp, 'POST', path, bodyStr);
    const res = await this.http.post(
      `${this.baseUrl}${path}`,
      payload,
      {
        'OK-ACCESS-KEY': this.apiKey(),
        'OK-ACCESS-PASSPHRASE': passphrase,
        'OK-ACCESS-TIMESTAMP': timestamp,
        'OK-ACCESS-SIGN': sign,
        'Content-Type': 'application/json',
      },
    );
    const body = res.body ?? {};
    const order: any = (body.data ?? [])[0] ?? {};
    const requestOk = res.status >= 200 && res.status < 300 && body.code === '0';
    const orderOk = order.sCode === '0' || order.sCode === undefined;
    if (!requestOk || !orderOk) {
      return {
        venue: this.name, status: 'REJECTED', filledQty: '0', avgPrice: '0',
        reason: normalizeError(order.sCode ?? body.code), raw: body,
      };
    }
    // OKX returns ordId on accept; fill detail is fetched separately. The fake
    // and richer adapters surface accFillSz / avgPx / fillSz inline.
    const filledQty = String(order.accFillSz ?? order.fillSz ?? '0');
    const avgPrice = String(order.avgPx ?? order.fillPx ?? '0');
    const requested = String(order.sz ?? filledQty);
    const status: OrderResult['status'] = filledQty === '0'
      ? 'REJECTED'
      : (requested !== '0' && requested !== filledQty ? 'PARTIAL' : 'FILLED');
    return { venue: this.name, status, filledQty, avgPrice, raw: body };
  }

  async health(): Promise<VenueHealth> {
    const t0 = this.now();
    try {
      const res = await this.http.post(
        `${this.baseUrl}/api/v5/system/status`, {}, { 'Content-Type': 'application/json' },
      );
      const body = res.body ?? {};
      // status code "0" + no ongoing maintenance windows in data => up.
      const maintenance = (body.data ?? []).some(
        (w: any) => w.state === 'ongoing' || w.state === 'scheduled',
      );
      const up = res.status >= 200 && res.status < 300 && body.code === '0' && !maintenance;
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
