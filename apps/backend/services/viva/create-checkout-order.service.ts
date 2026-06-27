/**
 * PROJECT TITAN — CreateCheckoutOrder use-case (APPLICATION layer).
 *
 * Creates the Viva hosted order AND persists it as PENDING so the asynchronous
 * webhook can later confirm it. Idempotent on correlation_token: a retry returns
 * the already-created order's checkout URL instead of opening a second order.
 */
import { CreateCheckoutOrderUseCase, CheckoutOrderGateway, CheckoutOrderRequest, CreateOrderOutcome } from './checkout';
import { OrderRepository, DuplicateOrderError } from './checkout-order.store';

export class CreateCheckoutOrderService implements CreateCheckoutOrderUseCase {
  constructor(
    private readonly gateway: CheckoutOrderGateway,
    private readonly orders: OrderRepository,
    private readonly checkoutBaseUrl: string,
  ) {}

  async create(req: CheckoutOrderRequest): Promise<CreateOrderOutcome> {
    // Idempotency: reuse an order already created for this correlation token.
    const existing = await this.orders.findByCorrelationToken(req.correlationToken);
    if (existing) {
      return { ok: true, orderCode: existing.orderCode, checkoutUrl: this.checkoutUrlFor(existing.orderCode) };
    }

    const outcome = await this.gateway.createOrder(req);
    if (!outcome.ok || !outcome.orderCode) return outcome;

    try {
      await this.orders.create({
        orderCode: outcome.orderCode,
        correlationToken: req.correlationToken,
        terminalId: req.terminalId,
        merchantId: req.merchantId,
        amountMinor: req.amountMinor,
        currency: req.currency,
      });
    } catch (e) {
      if (!(e instanceof DuplicateOrderError)) throw e;
      // Concurrent create with the same token won the race — reuse that order.
      const raced = await this.orders.findByCorrelationToken(req.correlationToken);
      if (raced) return { ok: true, orderCode: raced.orderCode, checkoutUrl: this.checkoutUrlFor(raced.orderCode) };
    }
    return outcome;
  }

  private checkoutUrlFor(orderCode: string): string {
    return `${this.checkoutBaseUrl}?ref=${orderCode}`;
  }
}
