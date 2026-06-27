/**
 * PROJECT TITAN — Postgres OrderRepository (DRIVEN/infrastructure).
 * Maps the checkout_order table (011 migration). Parameterized SQL only. The DB
 * triggers independently enforce immutability + forward-only status, so a bug
 * here cannot corrupt a settled order. Status transitions are written with a
 * `WHERE status = 'PENDING'` guard so they are idempotent even without the
 * trigger (the pg-mem tests rely on that guard; real Postgres adds enforcement).
 */
import { Queryable } from './pg-ledger.repository';
import {
  OrderRepository, NewCheckoutOrder, CheckoutOrderRecord, CheckoutOrderStatus, DuplicateOrderError,
} from './checkout-order.store';

const COLS =
  'order_code, correlation_token, terminal_id, merchant_id, amount_minor, currency, ' +
  'status, viva_transaction_id, created_at, updated_at, paid_at';

function toIso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}
function toIsoOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

/** Postgres unique-violation is SQLSTATE 23505; pg-mem surfaces it in the message. */
function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; message?: string };
  return err?.code === '23505' || /unique|duplicate key/i.test(String(err?.message ?? ''));
}

function mapRow(row: any): CheckoutOrderRecord {
  return {
    orderCode: String(row.order_code),
    correlationToken: row.correlation_token,
    terminalId: row.terminal_id,
    merchantId: row.merchant_id,
    amountMinor: Number(row.amount_minor),       // bigint comes back as string
    currency: row.currency,
    status: row.status as CheckoutOrderStatus,
    vivaTransactionId: row.viva_transaction_id ?? null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    paidAt: toIsoOrNull(row.paid_at),
  };
}

export class PgOrderRepository implements OrderRepository {
  constructor(private readonly db: Queryable) {}

  async create(o: NewCheckoutOrder): Promise<CheckoutOrderRecord> {
    try {
      const res = await this.db.query(
        `INSERT INTO checkout_order
           (order_code, correlation_token, terminal_id, merchant_id, amount_minor, currency)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING ${COLS}`,
        [o.orderCode, o.correlationToken, o.terminalId, o.merchantId, o.amountMinor, o.currency],
      );
      return mapRow(res.rows[0]);
    } catch (e) {
      if (isUniqueViolation(e)) throw new DuplicateOrderError(o.orderCode);
      throw e;
    }
  }

  async findByOrderCode(orderCode: string): Promise<CheckoutOrderRecord | null> {
    const res = await this.db.query(
      `SELECT ${COLS} FROM checkout_order WHERE order_code = $1`, [orderCode],
    );
    return res.rows.length ? mapRow(res.rows[0]) : null;
  }

  async findByCorrelationToken(token: string): Promise<CheckoutOrderRecord | null> {
    const res = await this.db.query(
      `SELECT ${COLS} FROM checkout_order WHERE correlation_token = $1`, [token],
    );
    return res.rows.length ? mapRow(res.rows[0]) : null;
  }

  async markPaid(orderCode: string, vivaTransactionId: string): Promise<CheckoutOrderRecord | null> {
    // Idempotent: only PENDING -> PAID writes. An already-PAID (or FAILED) order
    // is untouched; we return its current state so the caller stays idempotent.
    const res = await this.db.query(
      `UPDATE checkout_order
         SET status              = 'PAID',
             viva_transaction_id = COALESCE(viva_transaction_id, $2),
             paid_at             = COALESCE(paid_at, now())
       WHERE order_code = $1 AND status = 'PENDING'
       RETURNING ${COLS}`,
      [orderCode, vivaTransactionId],
    );
    if (res.rows.length) return mapRow(res.rows[0]);
    return this.findByOrderCode(orderCode);
  }

  async markFailed(orderCode: string): Promise<CheckoutOrderRecord | null> {
    const res = await this.db.query(
      `UPDATE checkout_order
         SET status = 'FAILED'
       WHERE order_code = $1 AND status = 'PENDING'
       RETURNING ${COLS}`,
      [orderCode],
    );
    if (res.rows.length) return mapRow(res.rows[0]);
    return this.findByOrderCode(orderCode);
  }
}
