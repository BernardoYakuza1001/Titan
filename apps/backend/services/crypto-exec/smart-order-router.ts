/**
 * PROJECT TITAN — Smart Order Router (Phase 5)
 *
 * Given a buy request, the SOR achieves BEST EXECUTION across all configured
 * venues without ever throwing money away on a bad fill:
 *
 *   1. HEALTH GATE / circuit breaker — query health() on every venue in parallel
 *      and drop any that are down OR have withdrawals disabled (we could buy but
 *      never deliver — useless and dangerous). Unhealthy venues are skipped, not
 *      retried, this pass.
 *   2. BEST NET PRICE — query getQuote() on every healthy venue in parallel and
 *      rank by NET price (quoted price grossed up by feeBps), cheapest first.
 *      All comparison is exact integer math on scaled BigInts — no floats.
 *   3. NOTIONAL SPLIT (TWAP/iceberg) — above a configurable threshold, slice the
 *      order into N child orders to reduce market impact / leakage, place them in
 *      sequence on the best venue, and AGGREGATE the fills (vwap avgPrice).
 *   4. VENUE FALLBACK — if a venue REJECTs or throws, fall through to the next
 *      best venue. If EVERY venue is unusable, return a STRUCTURED failure
 *      (never throw) so the engine/saga can reverse the fiat hold cleanly.
 *
 * The router takes a snapshot quote (the best venue's quote) so the caller can
 * enforce slippage against a single reference price.
 */
import {
  ExchangeAdapter, Quote, OrderResult, VenueHealth,
} from './exchange.port';
import {
  parseDecimal, formatDecimal, netPrice, mul, div, Scaled,
} from './decimal';

export interface BestExecRequest {
  clientOrderId: string;
  asset: string;
  fiatAmount: number;
  fiatCurrency: string;
  maxSlippageBps: number;
}

export interface BestExecSuccess {
  ok: true;
  venue: string;
  filledQty: string;     // aggregated, decimal string
  avgPrice: string;      // vwap across child fills, decimal string
  /**
   * Fiat actually spent on the (possibly partial) fill = sum of slice
   * filledQty*avgPrice, decimal string. The engine/saga reconciles this against
   * the requested notional so a short fill is never silently accepted while the
   * full fiat auth is captured.
   */
  filledNotional: string;
  /** True when any slice came back PARTIAL or the aggregate under-delivered. */
  partial: boolean;
  /** The reference quote (best net price) the fill should be slippage-checked against. */
  referenceQuote: Quote;
  /** Reference NET price (best net, fee-inclusive) as a decimal string — anchors fee-aware slippage. */
  referenceNetPrice: string;
  /** Taker fee (bps) of the venue that actually filled — grosses up the executed price for net slippage. */
  filledFeeBps: number;
  /** Per-venue attempt trail for audit. */
  attempts: AttemptRecord[];
}

export interface BestExecFailure {
  ok: false;
  reason: string;
  attempts: AttemptRecord[];
}

export type BestExecResult = BestExecSuccess | BestExecFailure;

export interface AttemptRecord {
  venue: string;
  outcome: 'SKIPPED_UNHEALTHY' | 'QUOTE_FAILED' | 'REJECTED' | 'THREW' | 'FILLED' | 'PARTIAL';
  reason?: string;
}

export interface SmartOrderRouterConfig {
  /** Notional (in fiat major units) at/above which we split into child orders. */
  splitThresholdFiat: number;
  /** Number of child slices when splitting (TWAP/iceberg). */
  childSlices: number;
}

export const DEFAULT_SOR_CONFIG: SmartOrderRouterConfig = {
  splitThresholdFiat: 10_000,
  childSlices: 4,
};

interface RankedVenue {
  adapter: ExchangeAdapter;
  quote: Quote;
  net: Scaled;   // net price scaled (for ranking only)
}

export class SmartOrderRouter {
  constructor(
    private readonly venues: ExchangeAdapter[],
    private readonly config: SmartOrderRouterConfig = DEFAULT_SOR_CONFIG,
  ) {}

  async bestExecution(req: BestExecRequest): Promise<BestExecResult> {
    const attempts: AttemptRecord[] = [];

    // ---- 1. Health gate (parallel) + circuit breaker --------------------------
    const healths = await Promise.all(
      this.venues.map(async (v): Promise<{ v: ExchangeAdapter; h: VenueHealth | null }> => {
        try { return { v, h: await v.health() }; }
        catch { return { v, h: null }; }
      }),
    );
    const healthy: ExchangeAdapter[] = [];
    for (const { v, h } of healths) {
      if (!h || !h.up || !h.withdrawalsEnabled) {
        attempts.push({
          venue: v.name, outcome: 'SKIPPED_UNHEALTHY',
          reason: !h ? 'HEALTH_THREW' : !h.up ? 'DOWN' : 'WITHDRAWALS_DISABLED',
        });
        continue;
      }
      healthy.push(v);
    }
    if (healthy.length === 0) {
      return { ok: false, reason: 'NO_HEALTHY_VENUE', attempts };
    }

    // ---- 2. Quote all healthy venues (parallel), rank by NET price ------------
    const quoted = await Promise.all(
      healthy.map(async (adapter): Promise<RankedVenue | null> => {
        try {
          const quote = await adapter.getQuote({
            asset: req.asset, fiatAmount: req.fiatAmount, fiatCurrency: req.fiatCurrency,
          });
          return { adapter, quote, net: netPrice(parseDecimal(quote.price), quote.feeBps) };
        } catch (e) {
          attempts.push({ venue: adapter.name, outcome: 'QUOTE_FAILED', reason: String((e as Error).message) });
          return null;
        }
      }),
    );
    const ranked = quoted.filter((q): q is RankedVenue => q !== null)
      .sort((a, b) => (a.net < b.net ? -1 : a.net > b.net ? 1 : 0)); // cheapest net first
    if (ranked.length === 0) {
      return { ok: false, reason: 'NO_VENUE_QUOTED', attempts };
    }

    const referenceQuote = ranked[0].quote;      // best net price anchors slippage
    const referenceNetPrice = formatDecimal(ranked[0].net); // fee-inclusive reference

    // ---- 3 + 4. Try venues best-first, splitting large notionals, with fallback
    for (const candidate of ranked) {
      const fill = await this.executeOnVenue(candidate.adapter, req, attempts);
      if (fill) {
        return {
          ok: true,
          venue: candidate.adapter.name,
          filledQty: fill.filledQty,
          avgPrice: fill.avgPrice,
          filledNotional: fill.filledNotional,
          partial: fill.partial,
          referenceQuote,
          referenceNetPrice,
          filledFeeBps: candidate.quote.feeBps,
          attempts,
        };
      }
      // else: rejected/threw — fall through to next-best venue (fallback)
    }

    return { ok: false, reason: 'ALL_VENUES_REJECTED', attempts };
  }

  /**
   * Place the (possibly sliced) order on a single venue and aggregate fills.
   * Returns aggregated fill on success, or null if the venue is unusable so the
   * caller can fall back to the next venue.
   */
  private async executeOnVenue(
    adapter: ExchangeAdapter,
    req: BestExecRequest,
    attempts: AttemptRecord[],
  ): Promise<{ filledQty: string; avgPrice: string; filledNotional: string; partial: boolean } | null> {
    const slices = this.planSlices(req.fiatAmount);

    let totalQty: Scaled = 0n;     // aggregated base qty (scaled)
    let totalCost: Scaled = 0n;    // aggregated fiat spent (scaled) for vwap + notional reconcile
    let anyFill = false;
    let anyPartial = false;
    let shortStop = false;         // a later slice rejected after earlier fills -> short aggregate

    for (let i = 0; i < slices.length; i++) {
      const sliceFiat = slices[i];
      // Child clientOrderId stays deterministic & unique per slice -> idempotent.
      const childId = slices.length === 1 ? req.clientOrderId : `${req.clientOrderId}#${i}`;
      let res: OrderResult;
      try {
        res = await adapter.placeOrder({
          clientOrderId: childId,
          asset: req.asset,
          fiatAmount: sliceFiat,
          fiatCurrency: req.fiatCurrency,
          maxSlippageBps: req.maxSlippageBps,
        });
      } catch (e) {
        attempts.push({ venue: adapter.name, outcome: 'THREW', reason: String((e as Error).message) });
        return null; // venue threw -> fall back
      }

      if (res.status === 'REJECTED') {
        attempts.push({ venue: adapter.name, outcome: 'REJECTED', reason: res.reason });
        // A rejection on the first slice means the venue is unusable -> fall back.
        // A rejection on a later slice: we already have partial fills on THIS
        // venue; stop slicing. The aggregate is SHORT of the requested notional —
        // flag it so the caller never accepts a short fill against full fiat.
        if (!anyFill) return null;
        shortStop = true;
        break;
      }

      anyFill = true;
      if (res.status === 'PARTIAL') anyPartial = true;
      const q = parseDecimal(res.filledQty);
      const p = parseDecimal(res.avgPrice);
      totalQty += q;
      totalCost += mul(q, p); // cost of this slice (scaled), for vwap + notional
    }

    if (!anyFill || totalQty === 0n) return null;

    const vwap = div(totalCost, totalQty); // aggregated avg price (scaled)
    const partial = anyPartial || shortStop;
    attempts.push({
      venue: adapter.name,
      outcome: partial ? 'PARTIAL' : 'FILLED',
    });
    return {
      filledQty: formatDecimal(totalQty),
      avgPrice: formatDecimal(vwap),
      filledNotional: formatDecimal(totalCost),
      partial,
    };
  }

  /** Split notional into N roughly-equal slices when above threshold (TWAP/iceberg). */
  private planSlices(fiatAmount: number): number[] {
    if (fiatAmount < this.config.splitThresholdFiat || this.config.childSlices <= 1) {
      return [fiatAmount];
    }
    const n = this.config.childSlices;
    // Integer-cent split so the slices sum EXACTLY to the notional (no float drift).
    const totalCents = Math.round(fiatAmount * 100);
    const base = Math.floor(totalCents / n);
    const remainder = totalCents - base * n;
    const slices: number[] = [];
    for (let i = 0; i < n; i++) {
      const cents = base + (i < remainder ? 1 : 0);
      slices.push(cents / 100);
    }
    return slices;
  }
}
