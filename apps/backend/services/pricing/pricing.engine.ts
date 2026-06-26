/**
 * PROJECT TITAN — Pricing Engine (Phase 4/5 — the revenue model)
 *
 * Turns a headline fiat charge into an explicit { auth this / spend this much }
 * split so every pass-through cost (acquirer, exchange taker, gas, FX) is funded
 * by the customer and the platform keeps a defined `markup`. See pricing.types.ts
 * for the identity. All math is integer minor units — no float decides money.
 *
 * Rounding rule: every cost/fee we collect is rounded UP (ceil) so we never
 * under-collect; the customer pays at most one minor unit more per fee line, and
 * the platform is never short. This mirrors the conservative gating elsewhere
 * (slippageBps ceils the buyer-adverse side; toBaseUnits refuses to round value
 * away). The acquisition budget absorbs the rounding, never the margin.
 */
import { BPS_DENOM } from '../crypto-exec/decimal';
import { ResolvedProfile } from '@titan/profile-schema';
import {
  PricingPolicy, PricingInputs, PricingResult, PriceQuote,
  ReconcileInputs, ReconcileResult,
} from './pricing.types';

/** Zero-decimal ISO-4217 currencies (minor unit == major unit). Extend as needed. */
const ZERO_DECIMAL_CURRENCIES = new Set([
  'JPY', 'KRW', 'VND', 'CLP', 'ISK', 'XOF', 'XAF', 'PYG', 'RWF', 'UGX',
]);

/** Minor-unit exponent for a currency (2 for most; 0 for zero-decimal currencies). */
export function minorExponent(currency: string): number {
  return ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? 0 : 2;
}

/**
 * Float-SAFE major -> integer minor units. Converts through the number's shortest
 * round-trip decimal string (e.g. (1.1).toString() === "1.1") instead of the
 * lossy `amount * 10**exp`. Over-precise inputs (more fractional digits than the
 * currency supports) are REJECTED rather than silently rounded — you cannot
 * charge 1.005 EUR, so we surface it instead of guessing. This is the correct
 * replacement for auth-engine's `toMinorUnits` (which uses float multiplication).
 */
export function majorToMinor(amount: number, exponent: number): bigint {
  if (!Number.isFinite(amount) || amount < 0) {
    throw new RangeError(`invalid money amount: ${amount}`);
  }
  const s = amount.toString();
  if (/[eE]/.test(s)) throw new RangeError(`exponential amounts unsupported: ${s}`);
  const [intPart, fracRaw = ''] = s.split('.');
  if (fracRaw.length > exponent) {
    throw new RangeError(`amount ${s} has more than ${exponent} minor digits`);
  }
  const frac = fracRaw.padEnd(exponent, '0');
  return BigInt(intPart) * 10n ** BigInt(exponent) + BigInt(frac || '0');
}

/** Integer minor units -> canonical decimal-string major units (for display/auth). */
export function minorToMajor(minor: bigint, exponent: number): string {
  const factor = 10n ** BigInt(exponent);
  const neg = minor < 0n;
  const abs = neg ? -minor : minor;
  const intPart = abs / factor;
  const body = exponent === 0
    ? `${intPart}`
    : `${intPart}.${(abs % factor).toString().padStart(exponent, '0')}`;
  return neg ? `-${body}` : body;
}

/** `amountMinor * bps / 10_000`, rounded UP (never under-collect). 0 for bps <= 0. */
function ceilBps(amountMinor: bigint, bps: number): bigint {
  const b = BigInt(Math.trunc(bps));
  if (b <= 0n) return 0n;
  return (amountMinor * b + (BPS_DENOM - 1n)) / BPS_DENOM;
}

function bigMax(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

/** Default policy: 1.5% margin or a 50-minor (e.g. €0.50) floor, whichever is greater. */
export const DEFAULT_PRICING_POLICY: PricingPolicy = {
  markupBps: 150,
  minMarginMinor: 50n,
};

/**
 * Per-risk-tier default markup (bps). Higher-control tiers carry more cost (KYC,
 * screening, manual review) and price accordingly; lockdown never prices a sale.
 * These are sensible defaults — operators tune them per profile/jurisdiction.
 */
export const RISK_TIER_MARKUP_BPS: Record<string, number> = {
  tier_low: 100,
  tier_std: 150,
  tier_high_controls: 250,
  tier_lockdown: 0,
};

/** Derive a pricing policy from a resolved profile's risk tier (with a margin floor). */
export function policyForProfile(p: ResolvedProfile, minMarginMinor = 50n): PricingPolicy {
  const markupBps = RISK_TIER_MARKUP_BPS[p.dimensions.riskTier] ?? DEFAULT_PRICING_POLICY.markupBps;
  return { markupBps, minMarginMinor };
}

export class PricingEngine {
  constructor(private readonly policy: PricingPolicy = DEFAULT_PRICING_POLICY) {}

  /**
   * Price one transaction. Returns the auth/spend split, or a structured failure
   * if the ticket cannot cover its own costs + margin (so the saga declines
   * cleanly rather than transacting at a loss).
   */
  quote(inp: PricingInputs): PricingResult {
    const exponent = minorExponent(inp.fiatCurrency);

    let charged: bigint;
    try {
      charged = majorToMinor(inp.fiatAmount, exponent);
    } catch (e) {
      return { ok: false, reason: 'INVALID_AMOUNT', detail: (e as Error).message };
    }
    if (charged <= 0n) {
      return { ok: false, reason: 'INVALID_AMOUNT', detail: 'amount must be > 0' };
    }

    // ---- fiat-rail costs + margin, taken off the charge ----
    const acquirerCost = ceilBps(charged, inp.acquirerCostBps);
    const fxSpread = ceilBps(charged, inp.fxSpreadBps ?? 0);
    const markup = bigMax(ceilBps(charged, this.policy.markupBps), this.policy.minMarginMinor);

    // Budget before crypto-rail costs. The taker fee is incurred on what we SPEND
    // at the venue (not on the full charge), so it is computed against preBudget.
    const preBudget = charged - acquirerCost - fxSpread - markup;
    if (preBudget <= 0n) {
      return { ok: false, reason: 'TICKET_TOO_SMALL', detail: 'charge does not cover acquiring + margin' };
    }

    // ---- crypto-rail costs ----
    const takerCost = ceilBps(preBudget, inp.exchangeTakerBps);
    const gas = inp.gasEstimateMinor > 0n ? inp.gasEstimateMinor : 0n;
    const budget = preBudget - takerCost - gas;
    if (budget <= 0n) {
      return { ok: false, reason: 'TICKET_TOO_SMALL', detail: 'charge does not cover taker fee + gas' };
    }

    const totalFee = charged - budget; // exact: == acquirer + fx + markup + taker + gas
    // Display-only effective take rate. Derived from integers; never used to decide money.
    const effectiveTakeRateBps = Number((totalFee * BPS_DENOM) / charged);

    return {
      ok: true,
      fiatCurrency: inp.fiatCurrency,
      exponent,
      fiatChargedMinor: charged,
      acquisitionBudgetMinor: budget,
      acquirerCostMinor: acquirerCost,
      fxSpreadMinor: fxSpread,
      takerCostMinor: takerCost,
      gasMinor: gas,
      markupMinor: markup,
      totalFeeMinor: totalFee,
      projectedSpreadMinor: markup,
      effectiveTakeRateBps,
    };
  }

  /**
   * Reconcile a fill against its quote. `realizedSpread` is what the platform
   * truly kept: the charge minus what the venue actually spent minus the fiat-rail
   * costs minus the real gas. The taker fee is embedded in `actualSpentMinor` at a
   * real venue, so it is not subtracted again. A venue that takes its fee out of
   * delivered qty (fee-inclusive) yields realized >= projected (positive variance);
   * genuine slippage beyond the budget+taker we reserved yields negative variance
   * and trips `overspend` / `marginIntact:false` for a margin alert / case.
   */
  reconcile(q: PriceQuote, act: ReconcileInputs): ReconcileResult {
    const actualGas = act.actualGasMinor ?? q.gasMinor;
    const realized =
      q.fiatChargedMinor - act.actualSpentMinor - q.acquirerCostMinor - q.fxSpreadMinor - actualGas;
    const venueAllowance = q.acquisitionBudgetMinor + q.takerCostMinor;
    return {
      realizedSpreadMinor: realized,
      projectedSpreadMinor: q.projectedSpreadMinor,
      varianceMinor: realized - q.projectedSpreadMinor,
      marginIntact: realized >= this.policy.minMarginMinor,
      overspend: act.actualSpentMinor > venueAllowance,
    };
  }
}
