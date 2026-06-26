/**
 * PROJECT TITAN — Pricing & Spread types (Phase 4/5 — the revenue model)
 *
 * The on-ramp's revenue model made EXPLICIT. Today the saga charges the customer
 * `fiatAmount` and spends that SAME amount buying crypto, so the exchange taker
 * fee, the acquirer fee, on-chain gas, and tolerated slippage are all eaten as
 * loss. This module closes that leak by splitting the single headline charge:
 *
 *   fiatCharged = acquisitionBudget          // what actually buys crypto
 *               + acquirerCost + fxSpread     // pass-through fiat-rail costs
 *               + takerCost + gas             // pass-through crypto-rail costs
 *               + markup                      // OUR margin — the only profit line
 *
 * MONEY RULE (same as the rest of the spine): every figure is an INTEGER in fiat
 * MINOR units (e.g. cents) — no float ever decides money. `acquisitionBudget` is
 * what the saga hands the SmartOrderRouter to spend, so the venue never spends
 * the customer's whole charge and the platform is made whole on EVERY txn.
 */

/** Per-profile pricing policy. The markup is the platform's gross margin. */
export interface PricingPolicy {
  /** Platform margin in basis points of the charged amount (the profit line). */
  markupBps: number;
  /** Absolute margin floor (minor units) so tiny tickets are never loss-making. */
  minMarginMinor: bigint;
}

/** Everything needed to price one transaction. bps are integers; gas is minor units. */
export interface PricingInputs {
  /** Headline amount the customer is charged, fiat MAJOR units (e.g. 150 or 150.00). */
  fiatAmount: number;
  /** ISO-4217 currency of the charge. */
  fiatCurrency: string;
  /** Acquirer cost in bps of the card charge (the least-cost route's costBps). */
  acquirerCostBps: number;
  /** Best venue's taker fee in bps (from the live Quote.feeBps that won routing). */
  exchangeTakerBps: number;
  /** Estimated on-chain network fee for the delivery, fiat MINOR units. */
  gasEstimateMinor: bigint;
  /** FX spread in bps when settling across currencies (0/omitted = same currency). */
  fxSpreadBps?: number;
}

/** A priced transaction. The saga auths `fiatChargedMinor`, spends `acquisitionBudgetMinor`. */
export interface PriceQuote {
  ok: true;
  fiatCurrency: string;
  /** Minor-unit exponent used (2, or 0 for zero-decimal currencies like JPY). */
  exponent: number;
  /** AUTH this on the card (integer minor units). */
  fiatChargedMinor: bigint;
  /** SPEND this acquiring crypto at the venue (integer minor units). */
  acquisitionBudgetMinor: bigint;
  // ---- fee breakdown (all integer minor units; sum == totalFeeMinor) ----
  acquirerCostMinor: bigint;
  fxSpreadMinor: bigint;
  takerCostMinor: bigint;
  gasMinor: bigint;
  markupMinor: bigint;
  /** fiatChargedMinor - acquisitionBudgetMinor (== the five fee lines above). */
  totalFeeMinor: bigint;
  // ---- economics ----
  /** Guaranteed gross profit before realized variance (== markupMinor). */
  projectedSpreadMinor: bigint;
  /** totalFee / charged, in bps — for display/telemetry only (derived, lossy). */
  effectiveTakeRateBps: number;
}

/** A transaction we refuse to price because it cannot be profitable / is invalid. */
export interface PricingFailure {
  ok: false;
  reason: 'TICKET_TOO_SMALL' | 'INVALID_AMOUNT';
  detail?: string;
}

export type PricingResult = PriceQuote | PricingFailure;

/** Actuals fed back after the fill so realized margin can be reconciled vs the quote. */
export interface ReconcileInputs {
  /** Fiat the venue actually debited acquiring crypto, MINOR units. */
  actualSpentMinor: bigint;
  /** Actual on-chain fee paid, MINOR units (defaults to the quoted gas estimate). */
  actualGasMinor?: bigint;
}

/** Outcome of comparing realized margin against the quote — drives margin alerts. */
export interface ReconcileResult {
  /** charged - actualSpent - acquirer - fx - actualGas (the margin we truly kept). */
  realizedSpreadMinor: bigint;
  /** What the quote promised (== markup). */
  projectedSpreadMinor: bigint;
  /** realized - projected; negative => margin compression (slippage/short/gas spike). */
  varianceMinor: bigint;
  /** realized margin still at/above the policy floor. */
  marginIntact: boolean;
  /** Venue spent more than the budget + taker we reserved for it (true slippage). */
  overspend: boolean;
}
