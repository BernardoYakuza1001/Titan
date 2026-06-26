/**
 * PROJECT TITAN — Viva auth strategies + Native Checkout (Basic) charge mode.
 */
import { BasicAuthProvider, BearerAuthProvider } from '../services/viva/viva-auth';
import { VivaWalletAcquiringAdapter, HttpClient } from '../services/viva/viva.adapter';
import { PaymentIntent } from '../services/viva/domain';

const intent = (): PaymentIntent => ({
  correlationToken: 'corr-9', terminalId: 'TERM-1', merchantId: 'M', amountMinor: 5000,
  currency: 'EUR', paymentToken: 'chargeTok', maskedPan: '411111****1111', cardBrand: 'VISA',
});

function fakeHttp(res: any) {
  const calls: any[] = [];
  const http: HttpClient = { async post(url, body, headers) { calls.push({ url, body, headers }); return res; } };
  return { http, calls };
}

describe('Viva auth providers', () => {
  it('BasicAuthProvider builds the Merchant ID : API Key header', async () => {
    expect(await new BasicAuthProvider('MID', 'KEY').authHeader())
      .toBe('Basic ' + Buffer.from('MID:KEY').toString('base64'));
  });
  it('BearerAuthProvider wraps the token provider', async () => {
    expect(await new BearerAuthProvider({ async accessToken() { return 'tok'; } }).authHeader())
      .toBe('Bearer tok');
  });
});

describe('VivaWalletAcquiringAdapter — Native Checkout (Basic) mode', () => {
  const basicCfg = {
    baseUrl: 'https://api.vivapayments.com',
    transactionsPath: '/nativecheckout/v2/transactions',
    sourceCode: '1937',
    sendCurrencyCode: false,
  };

  it('hits the native-checkout endpoint with Basic auth and OMITS currencyCode', async () => {
    const { http, calls } = fakeHttp({ status: 200, body: { StatusId: 'F', TransactionId: 'vt' } });
    const out = await new VivaWalletAcquiringAdapter(http, new BasicAuthProvider('MID', 'KEY'), basicCfg).charge(intent());
    expect(out.approved).toBe(true);
    expect(calls[0].url).toBe('https://api.vivapayments.com/nativecheckout/v2/transactions');
    expect(calls[0].headers.Authorization).toBe('Basic ' + Buffer.from('MID:KEY').toString('base64'));
    expect(calls[0].body.chargeToken).toBe('chargeTok');
    expect(calls[0].body.sourceCode).toBe('1937');
    expect(calls[0].body.currencyCode).toBeUndefined();   // currency derived from the source
  });
});
