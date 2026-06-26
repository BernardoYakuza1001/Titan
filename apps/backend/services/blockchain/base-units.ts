/**
 * PROJECT TITAN — Decimal-string -> integer base-unit conversion (Phase 6)
 *
 * MONEY RULE: on-chain amounts are NEVER floats. A quote arrives as a decimal
 * STRING (e.g. "0.10000000" BTC, "1.5" ETH) and we convert it to the chain's
 * smallest indivisible unit (satoshi/wei/lamport/sun) as a BigInt by pure
 * integer string manipulation — no Number(), no parseFloat, no precision loss.
 *
 *   toBaseUnits("1.5", 18)  -> 1500000000000000000n
 *   toBaseUnits("0.1",  8)  ->          10000000n
 *
 * Over-precise input (more fractional digits than the chain supports) is a hard
 * error rather than a silent round — rounding money is how value leaks.
 */

/** Convert a decimal-string quantity to integer base units for `decimals`. */
export function toBaseUnits(qty: string, decimals: number): bigint {
  if (typeof qty !== 'string') throw new Error('AMOUNT_NOT_STRING');
  const trimmed = qty.trim();
  if (trimmed.length === 0) throw new Error('AMOUNT_EMPTY');

  // Optional leading sign; on-chain transfers must be strictly positive.
  let s = trimmed;
  let negative = false;
  if (s[0] === '+') s = s.slice(1);
  else if (s[0] === '-') { negative = true; s = s.slice(1); }

  // Exactly one optional decimal point; digits only otherwise.
  if (!/^\d*(\.\d*)?$/.test(s) || s === '' || s === '.') {
    throw new Error(`AMOUNT_NOT_DECIMAL:${qty}`);
  }

  const [intPart, fracPartRaw = ''] = s.split('.');
  if (fracPartRaw.length > decimals) {
    // e.g. asking for 1e-9 BTC (9 dp) when BTC has only 8 -> would lose value.
    throw new Error(`AMOUNT_TOO_PRECISE:${qty}>${decimals}dp`);
  }

  const fracPadded = fracPartRaw.padEnd(decimals, '0');
  const combined = `${intPart || '0'}${fracPadded}`.replace(/^0+(?=\d)/, '');
  const value = BigInt(combined === '' ? '0' : combined);

  if (negative && value !== 0n) throw new Error('AMOUNT_NEGATIVE');
  return value;
}

/** Inverse — integer base units back to a canonical decimal string (for logs). */
export function fromBaseUnits(amount: bigint, decimals: number): string {
  const neg = amount < 0n;
  const abs = (neg ? -amount : amount).toString().padStart(decimals + 1, '0');
  const intPart = abs.slice(0, abs.length - decimals);
  const fracPart = decimals === 0 ? '' : abs.slice(abs.length - decimals).replace(/0+$/, '');
  const body = fracPart.length ? `${intPart}.${fracPart}` : intPart;
  return neg ? `-${body}` : body;
}
