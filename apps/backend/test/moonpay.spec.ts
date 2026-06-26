/**
 * PROJECT TITAN — MoonPay server-side integration tests.
 * Proves URL signing (secret key) and webhook verification (webhook key) with
 * the provided SANDBOX test keys — no network, fully deterministic.
 */
import { createHmac } from 'crypto';
import { MoonPayService } from '../services/moonpay/moonpay.service';
import { verifyMoonPayWebhook } from '../services/moonpay/moonpay.webhook';
import { MoonPayConfig } from '../services/moonpay/moonpay.config';

// SANDBOX test keys (no real money). Production keys come from env/secrets only.
const cfg: MoonPayConfig = {
  publishableKey: 'pk_test_pXOhkSZOXmci7RLFoOYE4H5wHFTM4B',
  secretKey: 'sk_test_larYOyZojk0Yyz0ZU1jggvpBxVJI8Dar',
  webhookKey: 'wk_test_H6jsfWKE8lEllU7U3dqPt4lvbFGZShI',
  environment: 'sandbox',
};

describe('MoonPay signed buy URL', () => {
  const svc = new MoonPayService(cfg);

  it('targets the sandbox widget and carries the publishable key', () => {
    const url = svc.buildSignedBuyUrl({ currencyCode: 'eth', walletAddress: '0x1111111111111111111111111111111111111111' });
    expect(url.startsWith('https://buy-sandbox.moonpay.com?')).toBe(true);
    expect(url).toContain('apiKey=pk_test_pXOhkSZOXmci7RLFoOYE4H5wHFTM4B');
    expect(url).toContain('currencyCode=eth');
    expect(url).toContain('walletAddress=0x1111111111111111111111111111111111111111');
    expect(url).toContain('&signature=');
  });

  it('signature is a deterministic HMAC-SHA256 of the query under the secret key', () => {
    const a = svc.buildSignedBuyUrl({ currencyCode: 'btc', walletAddress: 'bc1qexample' });
    const b = svc.buildSignedBuyUrl({ currencyCode: 'btc', walletAddress: 'bc1qexample' });
    expect(a).toBe(b); // stable

    const query = '?apiKey=' + cfg.publishableKey + '&currencyCode=btc';
    const expected = createHmac('sha256', cfg.secretKey).update(query).digest('base64');
    expect(svc.signQuery(query)).toBe(expected);
  });

  it('a tampered wallet address changes the signature', () => {
    const honest = svc.buildSignedBuyUrl({ currencyCode: 'eth', walletAddress: '0xAAAA' });
    const tampered = svc.buildSignedBuyUrl({ currencyCode: 'eth', walletAddress: '0xBBBB' });
    const sigOf = (u: string) => u.split('&signature=')[1];
    expect(sigOf(honest)).not.toBe(sigOf(tampered));
  });
});

describe('MoonPay webhook verification', () => {
  const body = JSON.stringify({ type: 'transaction_updated', data: { id: 'tx_1', status: 'completed' } });
  const t = '1718750000';
  const goodSig = createHmac('sha256', cfg.webhookKey).update(`${t}.${body}`).digest('hex');
  const header = `t=${t},s=${goodSig}`;

  it('accepts a correctly signed payload', () => {
    expect(verifyMoonPayWebhook(body, header, cfg.webhookKey)).toBe(true);
  });

  it('rejects a tampered body', () => {
    expect(verifyMoonPayWebhook(body + 'x', header, cfg.webhookKey)).toBe(false);
  });

  it('rejects a forged signature', () => {
    expect(verifyMoonPayWebhook(body, `t=${t},s=deadbeef`, cfg.webhookKey)).toBe(false);
  });

  it('rejects a stale timestamp when a clock is supplied (replay guard)', () => {
    expect(verifyMoonPayWebhook(body, header, cfg.webhookKey, { nowSeconds: Number(t) + 10_000 })).toBe(false);
    expect(verifyMoonPayWebhook(body, header, cfg.webhookKey, { nowSeconds: Number(t) + 60 })).toBe(true);
  });
});
