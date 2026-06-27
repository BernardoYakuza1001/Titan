/**
 * PROJECT TITAN — CreateCheckoutOrderService persists a PENDING order and is
 * idempotent on the correlation token (a retry reuses the order, no second
 * Viva order, and never persists when the gateway fails).
 */
import { CreateCheckoutOrderService } from '../services/viva/create-checkout-order.service';
import { CheckoutOrderGateway, CheckoutOrderRequest, CreateOrderOutcome } from '../services/viva/checkout';
import { MemOrderRepo } from './mem-order-repo.helper';

function gateway(outcome: CreateOrderOutcome, spy?: { count: number }): CheckoutOrderGateway {
  return { async createOrder() { if (spy) spy.count++; return outcome; } };
}

const req: CheckoutOrderRequest = {
  amountMinor: 100, currency: 'EUR', correlationToken: 'c1', terminalId: 'TERM-1', merchantId: 'M',
};

describe('CreateCheckoutOrderService', () => {
  it('creates the order, persists a PENDING row, returns the checkout URL', async () => {
    const repo = new MemOrderRepo();
    const svc = new CreateCheckoutOrderService(
      gateway({ ok: true, orderCode: 'OC9', checkoutUrl: 'https://x/web/checkout?ref=OC9' }),
      repo, 'https://x/web/checkout',
    );
    const out = await svc.create(req);
    expect(out.ok).toBe(true);
    expect(out.orderCode).toBe('OC9');
    const persisted = await repo.findByOrderCode('OC9');
    expect(persisted?.status).toBe('PENDING');
    expect(persisted?.amountMinor).toBe(100);
    expect(persisted?.terminalId).toBe('TERM-1');
  });

  it('is idempotent on correlation_token: a retry does not create a second Viva order', async () => {
    const repo = new MemOrderRepo();
    const spy = { count: 0 };
    const svc = new CreateCheckoutOrderService(
      gateway({ ok: true, orderCode: 'OC9', checkoutUrl: 'u' }, spy), repo, 'https://x/web/checkout',
    );
    await svc.create(req);
    const out2 = await svc.create(req);
    expect(spy.count).toBe(1);                                   // gateway hit once
    expect(out2.orderCode).toBe('OC9');
    expect(out2.checkoutUrl).toBe('https://x/web/checkout?ref=OC9');
  });

  it('does not persist anything when the gateway fails', async () => {
    const repo = new MemOrderRepo();
    const svc = new CreateCheckoutOrderService(
      gateway({ ok: false, error: { code: 'CONFIGURATION_ERROR', message: 'x', retriable: true } }),
      repo, 'u',
    );
    const out = await svc.create(req);
    expect(out.ok).toBe(false);
    expect(await repo.findByCorrelationToken('c1')).toBeNull();
  });
});
