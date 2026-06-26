/**
 * PROJECT TITAN — In-memory fake ExchangeAdapter (Phase 5 test double)
 *
 * A fully configurable fake venue for the integration tests. Per instance you
 * can set: price, fee, health (up / withdrawals), a forced REJECT, a PARTIAL
 * fill ratio, or a throw. It RECORDS every placeOrder by clientOrderId and is
 * IDEMPOTENT — a replay with the same clientOrderId returns the original fill
 * (and does NOT increment the placement counter), which is exactly what proves
 * the engine never double-buys on retry.
 *
 * All money math is decimal-string / integer based (no float), matching the
 * production adapters.
 */
import {
  ExchangeAdapter, Quote, QuoteRequest, PlaceOrderRequest, OrderResult,
  VenueHealth, EXCHANGE_REASON,
} from '../exchange.port';
import { parseDecimal, mul, div, formatDecimal } from '../decimal';

export interface FakeVenueConfig {
  name: string;
  /** Unit price as a decimal string (e.g. "60000.00"). */
  price: string;
  feeBps?: number;
  up?: boolean;
  withdrawalsEnabled?: boolean;
  latencyMs?: number;
  /** Force every placeOrder to REJECT with this reason. */
  reject?: string;
  /**
   * Fill the first N distinct placements, then REJECT the rest with this reason.
   * Simulates a venue that fills early slices then runs out of liquidity, which
   * leaves the aggregate SHORT of the requested notional.
   */
  rejectAfterPlacements?: { count: number; reason: string };
  /** Throw from placeOrder (simulates a network/venue error -> fallback). */
  throwOnOrder?: boolean;
  /** Throw from getQuote. */
  throwOnQuote?: boolean;
  /** Throw from health (treated as unhealthy by the router). */
  throwOnHealth?: boolean;
  /** Fraction of the requested notional that fills, as a decimal string (e.g. "0.5"). */
  partialRatio?: string;
  /**
   * Override the EXECUTION price (decimal string) vs the quoted price, to
   * simulate slippage. Defaults to the quoted `price`.
   */
  fillPrice?: string;
}

export interface RecordedOrder {
  req: PlaceOrderRequest;
  result: OrderResult;
}

export class InMemoryExchange implements ExchangeAdapter {
  readonly name: string;
  /** Orders by clientOrderId — proves idempotency and lets tests assert calls. */
  readonly orders = new Map<string, RecordedOrder>();
  /** Count of DISTINCT placements (replays do not increment). */
  placements = 0;
  /** Count of getQuote / health calls for assertions. */
  quoteCalls = 0;
  healthCalls = 0;

  constructor(private cfg: FakeVenueConfig) {
    this.name = cfg.name;
  }

  /** Mutate config mid-test (e.g. flip a venue down). */
  configure(patch: Partial<FakeVenueConfig>): void {
    this.cfg = { ...this.cfg, ...patch };
  }

  async getQuote(req: QuoteRequest): Promise<Quote> {
    this.quoteCalls++;
    if (this.cfg.throwOnQuote) throw new Error(`${this.name} quote unavailable`);
    const price = parseDecimal(this.cfg.price);
    const fiat = parseDecimal(req.fiatAmount.toString());
    const qty = price === 0n ? '0' : formatDecimal(div(fiat, price));
    return {
      venue: this.name,
      price: this.cfg.price,
      qty,
      feeBps: this.cfg.feeBps ?? 0,
      expiresAt: new Date(Date.now() + 5_000).toISOString(),
    };
  }

  async placeOrder(req: PlaceOrderRequest): Promise<OrderResult> {
    // IDEMPOTENCY: replay of the same clientOrderId returns the original fill.
    const existing = this.orders.get(req.clientOrderId);
    if (existing) return existing.result;

    if (this.cfg.throwOnOrder) throw new Error(`${this.name} order error`);

    // Reject once the configured number of distinct placements have filled.
    const rejectLater = this.cfg.rejectAfterPlacements;

    let result: OrderResult;
    if (this.cfg.reject) {
      result = {
        venue: this.name, status: 'REJECTED', filledQty: '0', avgPrice: '0',
        reason: this.cfg.reject,
      };
    } else if (rejectLater && this.placements >= rejectLater.count) {
      result = {
        venue: this.name, status: 'REJECTED', filledQty: '0', avgPrice: '0',
        reason: rejectLater.reason,
      };
      // A rejection is not a real placement: record it for idempotency but do NOT
      // bump the placement counter (so the "first N fill" count stays accurate).
      this.orders.set(req.clientOrderId, { req, result });
      return result;
    } else {
      const execPrice = this.cfg.fillPrice ?? this.cfg.price;
      const p = parseDecimal(execPrice);
      const fiat = parseDecimal(req.fiatAmount.toString());
      const fullQty = p === 0n ? 0n : div(fiat, p);
      const ratio = this.cfg.partialRatio ? parseDecimal(this.cfg.partialRatio) : null;
      const filled = ratio ? mul(fullQty, ratio) : fullQty;
      result = {
        venue: this.name,
        status: ratio ? 'PARTIAL' : 'FILLED',
        filledQty: formatDecimal(filled),
        avgPrice: execPrice,
        reason: ratio ? EXCHANGE_REASON.INSUFFICIENT_LIQUIDITY : undefined,
      };
    }

    this.placements++;
    this.orders.set(req.clientOrderId, { req, result });
    return result;
  }

  async health(): Promise<VenueHealth> {
    this.healthCalls++;
    if (this.cfg.throwOnHealth) throw new Error(`${this.name} health error`);
    return {
      venue: this.name,
      up: this.cfg.up ?? true,
      latencyMs: this.cfg.latencyMs ?? 5,
      withdrawalsEnabled: this.cfg.withdrawalsEnabled ?? true,
    };
  }
}
