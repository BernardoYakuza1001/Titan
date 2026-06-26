/**
 * PROJECT TITAN — MoonPay controller tests (sign-url + webhook endpoints).
 */
import { createHmac } from 'crypto';
import { MoonPayController, MoonPayEvent, MoonPayEventHandler } from '../services/moonpay/moonpay.controller';
import { MoonPayService } from '../services/moonpay/moonpay.service';
import { MoonPayConfig } from '../services/moonpay/moonpay.config';

const cfg: MoonPayConfig = {
  publishableKey: 'pk_test_pXOhkSZOXmci7RLFoOYE4H5wHFTM4B',
  secretKey: 'sk_test_larYOyZojk0Yyz0ZU1jggvpBxVJI8Dar',
  webhookKey: 'wk_test_H6jsfWKE8lEllU7U3dqPt4lvbFGZShI',
  environment: 'sandbox',
};

class RecordingHandler implements MoonPayEventHandler {
  events: MoonPayEvent[] = [];
  async onEvent(e: MoonPayEvent) { this.events.push(e); }
}

const FIXED_NOW = 1_718_750_000; // deterministic clock (seconds)

function build() {
  const handler = new RecordingHandler();
  const controller = new MoonPayController(new MoonPayService(cfg), cfg, handler, () => FIXED_NOW);
  return { controller, handler };
}

describe('POST /v1/moonpay/sign-url', () => {
  it('returns a signed sandbox widget URL carrying the request params', () => {
    const { controller } = build();
    const { url } = controller.signBuyUrl({
      asset: 'ETH', walletAddress: '0xabc', fiatCurrency: 'EUR', fiatAmount: '200',
      externalTransactionId: 'txn_42',
    });
    expect(url).toContain('https://buy-sandbox.moonpay.com?');
    expect(url).toContain('currencyCode=eth');
    expect(url).toContain('walletAddress=0xabc');
    expect(url).toContain('baseCurrencyCode=eur');
    expect(url).toContain('baseCurrencyAmount=200');
    expect(url).toContain('externalTransactionId=txn_42');
    expect(url).toContain('&signature=');
  });
});

describe('POST /v1/moonpay/webhook', () => {
  const body = JSON.stringify({ type: 'transaction_updated', data: { id: 'tx_1', status: 'completed' } });
  const t = String(FIXED_NOW - 5); // within tolerance
  const sig = createHmac('sha256', cfg.webhookKey).update(`${t}.${body}`).digest('hex');
  const header = `t=${t},s=${sig}`;

  it('accepts a valid webhook and forwards the event to the handler', async () => {
    const { controller, handler } = build();
    const res = await controller.webhook({ rawBody: body }, header);
    expect(res).toEqual({ received: true });
    expect(handler.events).toHaveLength(1);
    expect(handler.events[0].data.status).toBe('completed');
  });

  it('rejects a forged signature (401) and does NOT call the handler', async () => {
    const { controller, handler } = build();
    await expect(controller.webhook({ rawBody: body }, `t=${t},s=deadbeef`)).rejects.toThrow();
    expect(handler.events).toHaveLength(0);
  });

  it('rejects a stale timestamp outside the tolerance window', async () => {
    const { controller } = build();
    const oldT = String(FIXED_NOW - 10_000);
    const oldSig = createHmac('sha256', cfg.webhookKey).update(`${oldT}.${body}`).digest('hex');
    await expect(controller.webhook({ rawBody: body }, `t=${oldT},s=${oldSig}`)).rejects.toThrow();
  });
});
