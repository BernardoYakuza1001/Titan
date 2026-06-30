/**
 * PROJECT TITAN — Viva Smart Checkout (hosted order) — domain + ports.
 *
 * The most PCI-light Viva flow: the backend creates a payment ORDER (returns an
 * orderCode), the POS opens Viva's HOSTED checkout page for that order, and the
 * customer pays entirely on Viva's page. Neither the app nor Titan's backend ever
 * touch card data — Viva does. Order creation uses the verified Basic-auth scheme.
 */
import { AcquiringError } from './domain';

export interface CheckoutOrderRequest {
  amountMinor: number;        // integer minor units
  currency: string;           // ISO-4217 alpha (account currency drives the order)
  correlationToken: string;   // idempotency / reconciliation reference
  terminalId: string;
  merchantId: string;
  customerTrns?: string;      // shown to the customer on the Viva page
  /** Request a MOTO (manual/telephone) order — uses the MOTO payment source (no
   *  3DS/OTP) when one is configured; otherwise falls back to the e-commerce source. */
  moto?: boolean;
}

export interface CreateOrderOutcome {
  ok: boolean;
  orderCode?: string;
  checkoutUrl?: string;       // hosted page the POS opens, e.g. .../web/checkout?ref=<orderCode>
  error?: AcquiringError;
}

/** Driven port: create a Viva hosted-checkout order. */
export interface CheckoutOrderGateway {
  createOrder(req: CheckoutOrderRequest): Promise<CreateOrderOutcome>;
}

/** Driving port. */
export interface CreateCheckoutOrderUseCase {
  create(req: CheckoutOrderRequest): Promise<CreateOrderOutcome>;
}
