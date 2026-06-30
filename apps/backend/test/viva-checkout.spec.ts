/**
 * PROJECT TITAN — Viva Smart Checkout order gateway + controller.
 */
import { HttpException } from '@nestjs/common';
import { VivaOrderGateway } from '../services/viva/viva-order.gateway';
import { CheckoutController, CreateOrderDto } from '../services/viva/checkout.controller';
import { HttpClient } from '../services/viva/viva.adapter';
import { BasicAuthProvider, AuthHeaderProvider } from '../services/viva/viva-auth';
import { CreateCheckoutOrderUseCase, CheckoutOrderRequest, CreateOrderOutcome } from '../services/viva/checkout';

const cfg = {
  ordersUrl: 'https://www.vivapayments.com/api/orders',
  checkoutUrl: 'https://www.vivapayments.com/web/checkout',
  sourceCode: '1937',
};
const req: CheckoutOrderRequest = {
  amountMinor: 5000, currency: 'EUR', correlationToken: 'corr-1', terminalId: 'TERM-1', merchantId: 'M',
};

function http(res: any, opts: { throws?: boolean } = {}) {
  const calls: any[] = [];
  const h: HttpClient = { async post(u, b, hd) { calls.push({ u, b, hd }); if (opts.throws) throw new Error('net'); return res; } };
  return { h, calls };
}

describe('VivaOrderGateway', () => {
  it('creates an order (Basic auth) and returns the hosted checkout URL', async () => {
    const { h, calls } = http({ status: 200, body: { OrderCode: 175071618330, ErrorCode: 0 } });
    const out = await new VivaOrderGateway(h, new BasicAuthProvider('MID', 'KEY'), cfg).createOrder(req);
    expect(out.ok).toBe(true);
    expect(out.orderCode).toBe('175071618330');
    expect(out.checkoutUrl).toBe('https://www.vivapayments.com/web/checkout?ref=175071618330');
    expect(calls[0].u).toBe('https://www.vivapayments.com/api/orders');
    expect(calls[0].hd.Authorization).toBe('Basic ' + Buffer.from('MID:KEY').toString('base64'));
    expect(calls[0].b.Amount).toBe(5000);
    expect(calls[0].b.SourceCode).toBe('1937');
    expect(calls[0].b.MerchantTrns).toBe('corr-1');
  });
  it('uses the MOTO source when req.moto and a MOTO source is configured (no 3DS path)', async () => {
    const { h, calls } = http({ status: 200, body: { OrderCode: 1 } });
    await new VivaOrderGateway(h, new BasicAuthProvider('M', 'K'), { ...cfg, motoSourceCode: '2024' })
      .createOrder({ ...req, moto: true });
    expect(calls[0].b.SourceCode).toBe('2024');
  });

  it('falls back to the e-commerce source when MOTO is requested but none configured', async () => {
    const { h, calls } = http({ status: 200, body: { OrderCode: 1 } });
    await new VivaOrderGateway(h, new BasicAuthProvider('M', 'K'), cfg).createOrder({ ...req, moto: true });
    expect(calls[0].b.SourceCode).toBe('1937');
  });

  it('uses the e-commerce source by default (no moto flag)', async () => {
    const { h, calls } = http({ status: 200, body: { OrderCode: 1 } });
    await new VivaOrderGateway(h, new BasicAuthProvider('M', 'K'), { ...cfg, motoSourceCode: '2024' }).createOrder(req);
    expect(calls[0].b.SourceCode).toBe('1937');
  });

  it('sets AllowRecurring on the order when recurring is requested (establishes the MIT mandate)', async () => {
    const { h, calls } = http({ status: 200, body: { OrderCode: 1 } });
    await new VivaOrderGateway(h, new BasicAuthProvider('M', 'K'), cfg).createOrder({ ...req, recurring: true });
    expect(calls[0].b.AllowRecurring).toBe(true);
  });

  it('omits AllowRecurring by default', async () => {
    const { h, calls } = http({ status: 200, body: { OrderCode: 1 } });
    await new VivaOrderGateway(h, new BasicAuthProvider('M', 'K'), cfg).createOrder(req);
    expect(calls[0].b.AllowRecurring).toBeUndefined();
  });

  it('401 -> CONFIGURATION_ERROR', async () => {
    const { h } = http({ status: 401, body: {} });
    expect((await new VivaOrderGateway(h, new BasicAuthProvider('M', 'K'), cfg).createOrder(req)).error?.code).toBe('CONFIGURATION_ERROR');
  });
  it('thrown HTTP -> GATEWAY_TIMEOUT', async () => {
    const { h } = http({}, { throws: true });
    expect((await new VivaOrderGateway(h, new BasicAuthProvider('M', 'K'), cfg).createOrder(req)).error?.code).toBe('GATEWAY_TIMEOUT');
  });
  it('auth failure -> CONFIGURATION_ERROR, no HTTP call', async () => {
    const { h, calls } = http({ status: 200, body: { OrderCode: 1 } });
    const badAuth: AuthHeaderProvider = { async authHeader() { throw new Error('x'); } };
    const out = await new VivaOrderGateway(h, badAuth, cfg).createOrder(req);
    expect(out.error?.code).toBe('CONFIGURATION_ERROR');
    expect(calls).toHaveLength(0);
  });
});

describe('CheckoutController', () => {
  const useCase = (o: CreateOrderOutcome): CreateCheckoutOrderUseCase => ({ async create() { return o; } });
  const dto = { correlationToken: 'corr-1', merchantId: 'M', amountMinor: 5000, currency: 'eur' } as CreateOrderDto;

  it('returns orderCode + checkoutUrl on success', async () => {
    const ctrl = new CheckoutController(useCase({ ok: true, orderCode: '999', checkoutUrl: 'https://www.vivapayments.com/web/checkout?ref=999' }));
    const res = await ctrl.create('TERM-1', dto);
    expect(res.orderCode).toBe('999');
    expect(res.checkoutUrl).toContain('ref=999');
  });
  it('rejects when terminal identity is missing', async () => {
    const ctrl = new CheckoutController(useCase({ ok: true, orderCode: '1', checkoutUrl: 'u' }));
    await expect(ctrl.create(undefined, dto)).rejects.toThrow();
  });
  it('maps a gateway/config error to 502', async () => {
    const ctrl = new CheckoutController(useCase({ ok: false, error: { code: 'CONFIGURATION_ERROR', message: 'x', retriable: true } }));
    let err: unknown;
    try { await ctrl.create('TERM-1', dto); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(502);
  });
});
