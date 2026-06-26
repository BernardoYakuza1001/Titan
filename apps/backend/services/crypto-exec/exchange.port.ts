/**
 * PROJECT TITAN — Exchange Adapter Layer (Phase 5: Crypto Execution Engine)
 *
 * ONE normalized interface over every spot venue (Kraken, Coinbase, Binance,
 * OKX, ...). Each venue adapter translates the venue's REST quirks to/from this
 * shape so the SmartOrderRouter and the CryptoExecEngine never learn a venue's
 * idiosyncrasies (endpoint paths, auth header schemes, symbol formats, error
 * codes). This mirrors the payment-gateway adapter pattern (Phase 4).
 *
 * MONEY RULE: price/qty/feeBps semantics carry real money, so they are decimal
 * STRINGS (never JS floats). 0.1 + 0.2 !== 0.3 in IEEE-754; for crypto amounts
 * that error is theft. Callers that need to do math parse these strings into
 * BigInt base units (satoshi/wei) or a decimal library — never `Number()`.
 *
 * IDEMPOTENCY: `clientOrderId` makes placeOrder safe to replay. A venue (and our
 * fakes) MUST return the ORIGINAL fill for a repeated clientOrderId instead of
 * placing a second order. This is what lets the saga retry `crypto.buy()` after
 * a crash without ever double-buying.
 */

import { HttpClient } from '../payment/gateway/payment-gateway.port';

// Re-export so consumers of the crypto-exec barrel get the HTTP port from one
// place without reaching across into the payment service's internals.
export type { HttpClient };

/** Terminal order status, normalized across venues. */
export type OrderStatus = 'FILLED' | 'PARTIAL' | 'REJECTED';

/** A live, time-boxed quote. All money fields are decimal strings. */
export interface Quote {
  venue: string;
  /** Price of ONE unit of `asset` in the fiat currency, decimal string. */
  price: string;
  /** Quantity of `asset` purchasable for the requested fiat, decimal string. */
  qty: string;
  /** Taker fee in basis points (1 bp = 0.01%). Integer. */
  feeBps: number;
  /** ISO-8601 instant after which this quote must not be acted on. */
  expiresAt: string;
}

export interface QuoteRequest {
  asset: string;          // normalized symbol, e.g. "BTC", "ETH", "USDT"
  fiatAmount: number;     // notional in fiat MAJOR units (quote only — not on-chain)
  fiatCurrency: string;   // ISO-4217, e.g. "EUR", "USD"
}

export interface PlaceOrderRequest {
  /** Idempotency key. A replay with the same id returns the original fill. */
  clientOrderId: string;
  asset: string;
  fiatAmount: number;
  fiatCurrency: string;
  /** Max tolerated deviation of executed avgPrice vs quote, in basis points. */
  maxSlippageBps: number;
}

/** Result of a (possibly partial) fill. Money fields are decimal strings. */
export interface OrderResult {
  venue: string;
  status: OrderStatus;
  /** Filled base-asset quantity, decimal string ("0" if REJECTED). */
  filledQty: string;
  /** Volume-weighted average fill price, decimal string ("0" if REJECTED). */
  avgPrice: string;
  /** Normalized reason on REJECTED/PARTIAL (e.g. "INSUFFICIENT_LIQUIDITY"). */
  reason?: string;
  /** Original venue payload for audit/debug. */
  raw?: unknown;
}

export interface VenueHealth {
  venue: string;
  up: boolean;
  latencyMs: number;
  /** If withdrawals are disabled we can buy but never deliver — treat as down. */
  withdrawalsEnabled: boolean;
}

/** Every spot-venue adapter implements exactly this. */
export interface ExchangeAdapter {
  readonly name: string;
  getQuote(req: QuoteRequest): Promise<Quote>;
  placeOrder(req: PlaceOrderRequest): Promise<OrderResult>;
  health(): Promise<VenueHealth>;
}

/**
 * Normalized error reasons. Adapters map venue-specific codes onto these so the
 * router's fallback logic is venue-agnostic.
 */
export const EXCHANGE_REASON = {
  INSUFFICIENT_LIQUIDITY: 'INSUFFICIENT_LIQUIDITY',
  SLIPPAGE_EXCEEDED: 'SLIPPAGE_EXCEEDED',
  RATE_LIMITED: 'RATE_LIMITED',
  VENUE_REJECTED: 'VENUE_REJECTED',
  VENUE_UNAVAILABLE: 'VENUE_UNAVAILABLE',
  AUTH_FAILED: 'AUTH_FAILED',
  UNKNOWN: 'UNKNOWN',
} as const;
export type ExchangeReason = typeof EXCHANGE_REASON[keyof typeof EXCHANGE_REASON];
