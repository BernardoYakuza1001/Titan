/**
 * PROJECT TITAN — the single source of truth for "does this Viva transaction
 * confirm this order?". Used by BOTH confirmation paths so they cannot diverge:
 *   - webhook push  (ConfirmCheckoutPaymentService, by transaction id)
 *   - status pull   (GetOrderStatusService, by order code)
 *
 * A transaction confirms an order only when ALL hold: it succeeded (StatusId 'F'),
 * it belongs to THIS order code, its amount equals the order amount (scaled by the
 * currency's real minor-unit exponent, not a hardcoded *100), and — when Viva
 * reports a currency — it matches the order currency.
 */
import { VivaTransactionDetails } from './viva-verify';
import { minorExponent, numericCode } from './currency';

export interface OrderEconomics {
  orderCode: string;
  amountMinor: number;
  currency: string;
}

export function transactionConfirmsOrder(txn: VivaTransactionDetails, order: OrderEconomics): boolean {
  if (txn.statusId !== 'F') return false;
  if (txn.orderCode == null || String(txn.orderCode) !== String(order.orderCode)) return false;
  if (txn.amountMajor == null) return false;
  if (Math.round(txn.amountMajor * Math.pow(10, minorExponent(order.currency))) !== order.amountMinor) return false;
  const expectedNumeric = numericCode(order.currency);
  if (expectedNumeric != null && txn.currencyCode != null && String(txn.currencyCode) !== expectedNumeric) return false;
  return true;
}
