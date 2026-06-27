/**
 * PROJECT TITAN — ISO-4217 minor-unit helpers used by payment confirmation.
 */
import { minorExponent, numericCode, toMinor } from '../services/viva/currency';

describe('currency helpers', () => {
  it('minorExponent: 2 by default, 0 for JPY/KRW, 3 for Gulf currencies', () => {
    expect(minorExponent('EUR')).toBe(2);
    expect(minorExponent('usd')).toBe(2);
    expect(minorExponent('JPY')).toBe(0);
    expect(minorExponent('KRW')).toBe(0);
    expect(minorExponent('BHD')).toBe(3);
    expect(minorExponent('KWD')).toBe(3);
    expect(minorExponent('ZZZ')).toBe(2);   // unknown -> default 2
  });

  it('numericCode maps known currencies and is null for unknown', () => {
    expect(numericCode('EUR')).toBe('978');
    expect(numericCode('USD')).toBe('840');
    expect(numericCode('JPY')).toBe('392');
    expect(numericCode('ZZZ')).toBeNull();
  });

  it('toMinor scales by the currency exponent (the *100 bug fix)', () => {
    expect(toMinor(1.0, 'EUR')).toBe(100);
    expect(toMinor(12.34, 'USD')).toBe(1234);
    expect(toMinor(1000, 'JPY')).toBe(1000);   // would be 100000 under a hardcoded *100
    expect(toMinor(1.0, 'BHD')).toBe(1000);
  });
});
