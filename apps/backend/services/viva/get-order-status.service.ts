/**
 * PROJECT TITAN — Get checkout order status (APPLICATION layer).
 * Terminal-scoped: a terminal can only read its OWN orders, so the order code is
 * never a cross-terminal information leak (mirrors the terminal-history rule).
 */
import { OrderRepository, CheckoutOrderStatus } from './checkout-order.store';

export interface OrderStatusView {
  orderCode: string;
  status: CheckoutOrderStatus;
  amountMinor: number;
  currency: string;
  vivaTransactionId: string | null;
}

export class GetOrderStatusService {
  constructor(private readonly orders: OrderRepository) {}

  async byOrderCodeForTerminal(orderCode: string, terminalId: string): Promise<OrderStatusView | null> {
    const o = await this.orders.findByOrderCode(orderCode);
    if (!o || o.terminalId !== terminalId) return null; // not found OR not this terminal's
    return {
      orderCode: o.orderCode,
      status: o.status,
      amountMinor: o.amountMinor,
      currency: o.currency,
      vivaTransactionId: o.vivaTransactionId,
    };
  }
}
