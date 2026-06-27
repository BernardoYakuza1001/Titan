/**
 * PROJECT TITAN — in-memory OrderRepository for unit tests (not a *.spec.ts, so
 * jest does not collect it as a suite). Mirrors the PgOrderRepository semantics:
 * PENDING -> PAID/FAILED is forward-only and idempotent.
 */
import {
  OrderRepository, CheckoutOrderRecord, NewCheckoutOrder,
} from '../services/viva/checkout-order.store';

export class MemOrderRepo implements OrderRepository {
  private readonly byCode = new Map<string, CheckoutOrderRecord>();

  async create(o: NewCheckoutOrder): Promise<CheckoutOrderRecord> {
    for (const r of this.byCode.values()) {
      if (r.correlationToken === o.correlationToken) {
        const err = new Error('duplicate'); (err as any).code = '23505'; throw err;
      }
    }
    const rec: CheckoutOrderRecord = {
      orderCode: o.orderCode,
      correlationToken: o.correlationToken,
      terminalId: o.terminalId,
      merchantId: o.merchantId,
      amountMinor: o.amountMinor,
      currency: o.currency,
      status: 'PENDING',
      vivaTransactionId: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      paidAt: null,
    };
    this.byCode.set(o.orderCode, rec);
    return { ...rec };
  }

  async findByOrderCode(orderCode: string): Promise<CheckoutOrderRecord | null> {
    const r = this.byCode.get(orderCode);
    return r ? { ...r } : null;
  }

  async findByCorrelationToken(token: string): Promise<CheckoutOrderRecord | null> {
    for (const r of this.byCode.values()) if (r.correlationToken === token) return { ...r };
    return null;
  }

  async markPaid(orderCode: string, vivaTransactionId: string): Promise<CheckoutOrderRecord | null> {
    const r = this.byCode.get(orderCode);
    if (!r) return null;
    if (r.status === 'PENDING') {
      r.status = 'PAID';
      r.vivaTransactionId = vivaTransactionId;
      r.paidAt = '2026-01-01T00:00:01.000Z';
    }
    return { ...r };
  }

  async markFailed(orderCode: string): Promise<CheckoutOrderRecord | null> {
    const r = this.byCode.get(orderCode);
    if (!r) return null;
    if (r.status === 'PENDING') r.status = 'FAILED';
    return { ...r };
  }
}
