/**
 * PROJECT TITAN — Confirm a Viva Smart Checkout payment (APPLICATION layer).
 *
 * Driven by the webhook receiver. Webhook bodies are UNTRUSTED: we only advance
 * an order to PAID after independently re-fetching the transaction from Viva and
 * matching order code + currency + amount + success status. Every transition is
 * idempotent.
 *
 * IMPORTANT — failure events are deliberately NOT acted on. Viva documents that a
 * declined payment can be retried and FOLLOWED by a successful one, so a failure
 * webhook must never put the order in a terminal state that would block a later
 * genuine success. The failure POST is also forgeable (the endpoint is public and
 * the order code is visible to the payer), so trusting it would be a denial-of-
 * payment hole. We leave such orders PENDING; an unpaid order simply never settles.
 */
import { OrderRepository } from './checkout-order.store';
import { VivaTransactionVerifier } from './viva-verify';
import { transactionConfirmsOrder } from './payment-match';

export type ConfirmResult =
  | 'PAID'                     // verified and marked paid (or already paid)
  | 'NOTED_FAILURE'            // a failure event was received; order left PENDING (not trusted)
  | 'IGNORED_UNKNOWN_ORDER'    // we have no such order (not ours / not yet created)
  | 'IGNORED_ALREADY_FINAL'    // already PAID — nothing to do
  | 'IGNORED_EVENT'            // event type we don't act on
  | 'REJECTED_VERIFICATION';   // claimed paid but Viva lookup did not confirm

export interface WebhookEvent {
  eventTypeId: number;
  orderCode: string | null;
  transactionId: string | null;
}

/** Viva EventTypeId values. */
const EVENT_PAYMENT_CREATED = 1796; // Transaction Payment Created (success)
const FAIL_EVENTS = new Set<number>([1798]); // Transaction Failed (NOT trusted — see header)

export class ConfirmCheckoutPaymentService {
  constructor(
    private readonly orders: OrderRepository,
    private readonly verifier: VivaTransactionVerifier,
  ) {}

  async handle(ev: WebhookEvent): Promise<ConfirmResult> {
    if (!ev.orderCode) return 'IGNORED_EVENT';

    const order = await this.orders.findByOrderCode(ev.orderCode);
    if (!order) return 'IGNORED_UNKNOWN_ORDER';
    if (order.status !== 'PENDING') return 'IGNORED_ALREADY_FINAL';

    // Failure events are acknowledged but NOT trusted: never transition to a final
    // state on them (forgeable + Viva allows retry-after-failure). Order stays PENDING.
    if (FAIL_EVENTS.has(ev.eventTypeId)) return 'NOTED_FAILURE';

    if (ev.eventTypeId !== EVENT_PAYMENT_CREATED) return 'IGNORED_EVENT';
    if (!ev.transactionId) return 'REJECTED_VERIFICATION';

    // INDEPENDENT verification — never trust the webhook payload. Re-fetch the
    // transaction from Viva under our own credentials and match every economic fact
    // (same matcher the pull path uses, so the two can never diverge).
    const txn = await this.verifier.getTransaction(ev.transactionId);
    if (!txn) return 'REJECTED_VERIFICATION';
    if (!transactionConfirmsOrder(txn, order)) return 'REJECTED_VERIFICATION';

    await this.orders.markPaid(order.orderCode, txn.transactionId);
    return 'PAID';
  }
}
