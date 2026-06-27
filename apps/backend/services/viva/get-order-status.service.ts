/**
 * PROJECT TITAN — Get checkout order status (APPLICATION layer).
 *
 * Terminal-scoped: a terminal can only read its OWN orders, so the order code is
 * never a cross-terminal information leak (mirrors the terminal-history rule).
 *
 * SELF-CONFIRMING (pull): when the order is still PENDING, this asks Viva directly
 * whether the order has a confirming transaction and settles it on the spot. That
 * makes confirmation work even if the webhook is never registered or is missed
 * (e.g. while the free-tier service was asleep). The webhook remains the fast push
 * path; this is the resilient pull path — both use the same matcher, so a payment
 * is accepted under identical rules whichever path observes it first.
 */
import { OrderRepository, CheckoutOrderRecord, CheckoutOrderStatus } from './checkout-order.store';
import { VivaTransactionVerifier } from './viva-verify';
import { transactionConfirmsOrder } from './payment-match';

export interface OrderStatusView {
  orderCode: string;
  status: CheckoutOrderStatus;
  amountMinor: number;
  currency: string;
  vivaTransactionId: string | null;
}

export class GetOrderStatusService {
  constructor(
    private readonly orders: OrderRepository,
    private readonly verifier: VivaTransactionVerifier,
  ) {}

  async byOrderCodeForTerminal(orderCode: string, terminalId: string): Promise<OrderStatusView | null> {
    let o = await this.orders.findByOrderCode(orderCode);
    if (!o || o.terminalId !== terminalId) return null; // not found OR not this terminal's

    if (o.status === 'PENDING') {
      const settled = await this.pullConfirm(o);
      if (settled) o = settled;
    }

    return {
      orderCode: o.orderCode,
      status: o.status,
      amountMinor: o.amountMinor,
      currency: o.currency,
      vivaTransactionId: o.vivaTransactionId,
    };
  }

  /** Ask Viva directly; if a transaction confirms the order, mark it paid. */
  private async pullConfirm(order: CheckoutOrderRecord): Promise<CheckoutOrderRecord | null> {
    const txns = await this.verifier.listTransactionsByOrder(order.orderCode);
    const hit = txns.find((t) => transactionConfirmsOrder(t, order));
    if (!hit) return null;
    return this.orders.markPaid(order.orderCode, hit.transactionId);
  }
}
