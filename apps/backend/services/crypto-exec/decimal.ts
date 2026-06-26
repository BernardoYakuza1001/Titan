/**
 * PROJECT TITAN — Fixed-point decimal helpers for the Crypto Execution Engine.
 *
 * MONEY RULE: no floats anywhere money is decided. Quotes arrive as decimal
 * strings; slippage gating and net-price comparison are exact integer math on
 * BigInt scaled by a fixed number of decimal places. We never call Number() on
 * a price or quantity.
 *
 * Representation: a decimal string "D.DDDD" is parsed to a BigInt scaled by
 * 10^SCALE (`Scaled`). All comparisons/arithmetic used for gating happen in this
 * integer domain. Basis points (bps) are integers; 10_000 bps = 100%.
 */

/** Working precision. 18 covers wei-grade assets without overflow for our sizes. */
export const SCALE = 18n;
const SCALE_FACTOR = 10n ** SCALE;

/** Basis-points denominator. 10_000 bps = 1.0 (100%). */
export const BPS_DENOM = 10_000n;

/** A decimal value held as an integer scaled by 10^SCALE. */
export type Scaled = bigint;

/** Parse a non-negative decimal string into a Scaled BigInt. Rejects floats/NaN. */
export function parseDecimal(s: string): Scaled {
  if (typeof s !== 'string') throw new TypeError(`decimal must be a string, got ${typeof s}`);
  const trimmed = s.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new RangeError(`invalid decimal string: "${s}"`);
  }
  const [intPart, fracPartRaw = ''] = trimmed.split('.');
  // Pad/truncate the fractional part to exactly SCALE digits (truncate = round down).
  const frac = fracPartRaw.slice(0, Number(SCALE)).padEnd(Number(SCALE), '0');
  return BigInt(intPart) * SCALE_FACTOR + BigInt(frac);
}

/** Format a Scaled BigInt back to a canonical decimal string (trailing zeros trimmed). */
export function formatDecimal(v: Scaled): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const intPart = abs / SCALE_FACTOR;
  const fracPart = abs % SCALE_FACTOR;
  let frac = fracPart.toString().padStart(Number(SCALE), '0').replace(/0+$/, '');
  const body = frac.length ? `${intPart}.${frac}` : `${intPart}`;
  return neg ? `-${body}` : body;
}

/** Multiply two Scaled values, returning a Scaled value (re-normalized). */
export function mul(a: Scaled, b: Scaled): Scaled {
  return (a * b) / SCALE_FACTOR;
}

/** Divide two Scaled values, returning a Scaled value (re-normalized). */
export function div(a: Scaled, b: Scaled): Scaled {
  if (b === 0n) throw new RangeError('division by zero');
  return (a * SCALE_FACTOR) / b;
}

/**
 * NET price = quoted price grossed up by the taker fee. A buyer paying `price`
 * plus `feeBps` effectively pays `price * (1 + feeBps/10_000)` per unit, so this
 * is the correct figure to MINIMIZE when picking the best venue.
 */
export function netPrice(price: Scaled, feeBps: number): Scaled {
  const fee = BigInt(Math.trunc(feeBps));
  // price * (BPS_DENOM + fee) / BPS_DENOM — all integer, no float.
  return (price * (BPS_DENOM + fee)) / BPS_DENOM;
}

/**
 * Slippage in basis points of `executed` vs `reference`. Positive means executed
 * is MORE expensive than the reference (adverse for a buyer); negative/zero means
 * we did at least as well as quoted.
 *
 * The buyer-adverse side (positive numerator) is rounded AWAY from zero (ceil) so
 * the gate is CONSERVATIVE: a true 50.99 bps fill reports 51, never 50, and can
 * never slip under an exact-bps tolerance. Plain truncation here would round down
 * and let a marginally-out-of-tolerance fill through (<1 bps, but directionally
 * wrong for irreversible-money gating). The favorable side truncates toward zero,
 * which is harmless since it passes the gate regardless.
 */
export function slippageBps(reference: Scaled, executed: Scaled): bigint {
  if (reference <= 0n) return 0n;
  const numerator = (executed - reference) * BPS_DENOM;
  return numerator > 0n ? (numerator + reference - 1n) / reference : numerator / reference;
}

/** True when executed price is within `maxBps` of reference (buyer-adverse side only). */
export function withinSlippage(reference: Scaled, executed: Scaled, maxBps: number): boolean {
  return slippageBps(reference, executed) <= BigInt(Math.trunc(maxBps));
}
