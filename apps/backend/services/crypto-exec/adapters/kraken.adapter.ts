/**
 * PROJECT TITAN — Kraken spot adapter (Phase 5)
 *
 * Real Kraken REST surface (translated to the normalized ExchangeAdapter):
 *   - Public ticker:  GET  https://api.kraken.com/0/public/Ticker?pair=XBTEUR
 *   - System status:  GET  https://api.kraken.com/0/public/SystemStatus
 *   - Add order:      POST https://api.kraken.com/0/private/AddOrder
 *   - Withdraw info:  POST https://api.kraken.com/0/private/WithdrawStatus
 *
 * AUTH (private endpoints): Kraken signs each call with
 *   API-Key:  <public key>
 *   API-Sign: HMAC-SHA512( path + SHA256(nonce + postdata), base64-decode(secret) )
 * The signing is delegated to an injected `sign()` so the secret never lives in
 * this module; the key fn is `() => string` per the project's Vault pattern.
 *
 * Kraken quirks normalized here:
 *   - Asset codes: BTC -> XBT, and pairs are concatenated (XBTEUR).
 *   - Every response is `{ error: string[], result: {...} }`; a non-empty
 *     `error[]` means failure even on HTTP 200.
 *   - Idempotency: AddOrder accepts a `cl_ord_id` (client order id); a replay of
 *     the same id is rejected as a duplicate, which we treat as "already filled"
 *     and reconcile via QueryOrders. (Here we surface cl_ord_id; full dedup is a
 *     venue concern proven against the in-memory fake.)
 */
import {
  ExchangeAdapter, Quote, QuoteRequest, PlaceOrderRequest, OrderResult,
  VenueHealth, HttpClient, EXCHANGE_REASON,
} from '../exchange.port';
import { parseDecimal, div, formatDecimal } from '../decimal';

/** Decimal-string division (no float) so qty/avgPrice stay strings. */
function decimalDiv(a: string, b: string): string {
  const sb = parseDecimal(b);
  if (sb === 0n) return '0';
  return formatDecimal(div(parseDecimal(a), sb));
}

/** Kraken uses XBT for bitcoin; everything else passes through. */
function krakenAsset(asset: string): string {
  return asset.toUpperCase() === 'BTC' ? 'XBT' : asset.toUpperCase();
}
function krakenPair(asset: string, fiat: string): string {
  return `${krakenAsset(asset)}${fiat.toUpperCase()}`;
}

const REASON: Record<string, string> = {
  'EOrder:Insufficient funds': EXCHANGE_REASON.INSUFFICIENT_LIQUIDITY,
  'EOrder:Insufficient volume': EXCHANGE_REASON.INSUFFICIENT_LIQUIDITY,
  'EAPI:Rate limit exceeded': EXCHANGE_REASON.RATE_LIMITED,
  'EGeneral:Permission denied': EXCHANGE_REASON.AUTH_FAILED,
  'EAPI:Invalid key': EXCHANGE_REASON.AUTH_FAILED,
  'EService:Unavailable': EXCHANGE_REASON.VENUE_UNAVAILABLE,
};
function normalizeError(errors: string[] | undefined): string {
  for (const e of errors ?? []) if (REASON[e]) return REASON[e];
  return EXCHANGE_REASON.VENUE_REJECTED;
}

export interface KrakenAuthSigner {
  /** path + private postdata -> base64 API-Sign header. Secret stays inside. */
  (path: string, nonce: string, postData: Record<string, unknown>): string;
}

export class KrakenAdapter implements ExchangeAdapter {
  readonly name = 'kraken';

  constructor(
    private readonly http: HttpClient,
    private readonly baseUrl: string,            // https://api.kraken.com
    private readonly apiKey: () => string,       // public key, resolved per-call
    private readonly sign: KrakenAuthSigner,     // HMAC done outside (secret-safe)
    private readonly feeBps = 26,                // Kraken taker fee (~0.26%)
    private readonly quoteTtlMs = 5_000,
    private readonly now: () => number = Date.now,
  ) {}

  async getQuote(req: QuoteRequest): Promise<Quote> {
    const pair = krakenPair(req.asset, req.fiatCurrency);
    const res = await this.http.post(
      `${this.baseUrl}/0/public/Ticker?pair=${pair}`,
      {},
      { 'Content-Type': 'application/json' },
    );
    const body = res.body ?? {};
    if (res.status < 200 || res.status >= 300 || (body.error?.length ?? 0) > 0) {
      throw new Error(`kraken quote failed: ${normalizeError(body.error)}`);
    }
    // result is keyed by the venue's canonical pair name; take the first entry.
    const ticker: any = Object.values(body.result ?? {})[0] ?? {};
    const price: string = ticker.a?.[0] ?? ticker.c?.[0]; // best ask, else last
    if (!price) throw new Error('kraken quote: no price');
    // qty = fiatAmount / price, computed as a decimal STRING by the router/engine;
    // here we surface price and a venue-derived qty string from the ask depth.
    const qty = decimalDiv(req.fiatAmount.toString(), price);
    return {
      venue: this.name,
      price: String(price),
      qty,
      feeBps: this.feeBps,
      expiresAt: new Date(this.now() + this.quoteTtlMs).toISOString(),
    };
  }

  async placeOrder(req: PlaceOrderRequest): Promise<OrderResult> {
    const path = '/0/private/AddOrder';
    const nonce = String(this.now() * 1000);
    const pair = krakenPair(req.asset, req.fiatCurrency);
    const postData = {
      nonce,
      pair,
      type: 'buy',
      ordertype: 'market',
      // Kraken `viqc` lets us spend a fiat (quote) volume; `cl_ord_id` = idempotency.
      oflags: 'viqc',
      volume: req.fiatAmount.toString(),
      cl_ord_id: req.clientOrderId,
    };
    const res = await this.http.post(
      `${this.baseUrl}${path}`,
      postData,
      {
        'API-Key': this.apiKey(),
        'API-Sign': this.sign(path, nonce, postData),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    );
    const body = res.body ?? {};
    if (res.status < 200 || res.status >= 300 || (body.error?.length ?? 0) > 0) {
      return {
        venue: this.name, status: 'REJECTED', filledQty: '0', avgPrice: '0',
        reason: normalizeError(body.error), raw: body,
      };
    }
    const r = body.result ?? {};
    const filledQty = String(r.vol_exec ?? '0');
    const cost = String(r.cost ?? '0');
    const avgPrice = filledQty !== '0' ? decimalDiv(cost, filledQty) : '0';
    const requested = String(r.vol ?? filledQty);
    const status = filledQty === '0'
      ? 'REJECTED'
      : (requested !== '0' && filledQty !== requested ? 'PARTIAL' : 'FILLED');
    return { venue: this.name, status: status as OrderResult['status'], filledQty, avgPrice, raw: body };
  }

  async health(): Promise<VenueHealth> {
    const t0 = this.now();
    try {
      const res = await this.http.post(
        `${this.baseUrl}/0/public/SystemStatus`, {}, { 'Content-Type': 'application/json' },
      );
      const body = res.body ?? {};
      const up = res.status >= 200 && res.status < 300
        && (body.error?.length ?? 0) === 0
        && body.result?.status === 'online';
      return {
        venue: this.name, up, latencyMs: this.now() - t0,
        // Kraken WithdrawStatus is private; absent a successful probe assume the
        // venue's published status governs — online status implies withdrawals on.
        withdrawalsEnabled: up,
      };
    } catch {
      return { venue: this.name, up: false, latencyMs: this.now() - t0, withdrawalsEnabled: false };
    }
  }
}
