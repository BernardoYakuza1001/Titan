/**
 * PROJECT TITAN — Viva Smart Checkout order store (DRIVEN port + domain).
 *
 * The hosted-checkout flow is asynchronous, so we persist the order at creation
 * (PENDING) and advance it to PAID/FAILED only when a Viva webhook event is
 * INDEPENDENTLY confirmed against Viva's transaction API. No card data is ever
 * stored here — the card is entered on Viva's hosted page.
 */

export type CheckoutOrderStatus = 'PENDING' | 'PAID' | 'FAILED';

/** The persisted order record — mirrors `checkout_order` (011 migration). */
export interface CheckoutOrderRecord {
  orderCode: string;
  correlationToken: string;
  terminalId: string;
  merchantId: string;
  amountMinor: number;
  currency: string;
  status: CheckoutOrderStatus;
  vivaTransactionId: string | null;
  createdAt: string;
  updatedAt: string;
  paidAt: string | null;
}

export interface NewCheckoutOrder {
  orderCode: string;
  correlationToken: string;
  terminalId: string;
  merchantId: string;
  amountMinor: number;
  currency: string;
}

/** Thrown when order_code / correlation_token already exists (idempotency). */
export class DuplicateOrderError extends Error {
  constructor(public readonly key: string) {
    super(`duplicate checkout order: ${key}`);
    this.name = 'DuplicateOrderError';
  }
}

/** Persistence of the immutable checkout-order lifecycle. */
export interface OrderRepository {
  /** Insert a PENDING order. Throws DuplicateOrderError on order_code/token conflict. */
  create(o: NewCheckoutOrder): Promise<CheckoutOrderRecord>;
  findByOrderCode(orderCode: string): Promise<CheckoutOrderRecord | null>;
  findByCorrelationToken(token: string): Promise<CheckoutOrderRecord | null>;
  /**
   * PENDING -> PAID (idempotent). Only a PENDING order transitions; an already
   * PAID/FAILED order is returned unchanged. Returns null if no such order.
   */
  markPaid(orderCode: string, vivaTransactionId: string): Promise<CheckoutOrderRecord | null>;
  /** PENDING -> FAILED (idempotent). Returns null if no such order. */
  markFailed(orderCode: string): Promise<CheckoutOrderRecord | null>;
}
