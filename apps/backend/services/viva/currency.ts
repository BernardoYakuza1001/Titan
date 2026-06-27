/**
 * PROJECT TITAN — minimal ISO-4217 helpers for payment confirmation.
 *
 * Two things the confirmation needs and must NOT hardcode:
 *   - minorExponent: how many minor digits a currency has, so we can convert
 *     Viva's MAJOR amount (e.g. 1.00) to our stored minor units correctly. Most
 *     currencies use 2; JPY/KRW use 0; a few Gulf currencies use 3. Getting this
 *     wrong made legitimate non-2-decimal payments impossible to confirm.
 *   - numericCode: the ISO-4217 numeric code Viva reports as CurrencyCode (e.g.
 *     "978" for EUR), so we can assert the paid currency matches the order.
 *
 * Unknown currencies default to exponent 2 (the overwhelming majority) but have a
 * null numeric code, so the currency-equality check is simply skipped for them
 * rather than blocking — the order-code + amount binding still applies.
 */

/** Currencies whose minor-unit exponent is NOT 2 (the default). */
const EXPONENT_EXCEPTIONS: Record<string, number> = {
  JPY: 0, KRW: 0, CLP: 0, ISK: 0, VND: 0, XOF: 0, XAF: 0, PYG: 0, UGX: 0, RWF: 0,
  BHD: 3, KWD: 3, OMR: 3, TND: 3, JOD: 3, LYD: 3, IQD: 3,
};

/** ISO-4217 alpha -> numeric, for the currencies we recognise. */
const NUMERIC: Record<string, string> = {
  EUR: '978', USD: '840', GBP: '826', CHF: '756', SEK: '752', NOK: '578', DKK: '208',
  PLN: '985', RON: '946', BGN: '975', CZK: '203', HUF: '348', JPY: '392', KRW: '410',
  AUD: '036', CAD: '124', NZD: '554', ZAR: '710', BHD: '048', KWD: '414',
};

export function minorExponent(alpha: string): number {
  const a = (alpha ?? '').toUpperCase();
  return a in EXPONENT_EXCEPTIONS ? EXPONENT_EXCEPTIONS[a] : 2;
}

export function numericCode(alpha: string): string | null {
  return NUMERIC[(alpha ?? '').toUpperCase()] ?? null;
}

/** Convert a MAJOR amount (Viva) to minor units for the given currency. */
export function toMinor(amountMajor: number, alpha: string): number {
  return Math.round(amountMajor * Math.pow(10, minorExponent(alpha)));
}
