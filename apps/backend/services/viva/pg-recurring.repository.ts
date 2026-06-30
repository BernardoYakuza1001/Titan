/**
 * PROJECT TITAN — Postgres RecurringRepository (DRIVEN/infrastructure).
 * Maps the recurring_charge table (012 migration). Parameterized SQL only.
 * Insert-then-catch on unique(correlation_token) gives idempotency; the DB
 * triggers independently enforce immutability + forward-only status.
 */
import { Queryable } from './pg-ledger.repository';
import { DuplicateCorrelationError } from './domain';
import {
  RecurringRepository, NewRecurringCharge, RecurringChargeRecord, RecurringStatus, RecurringStatusPatch,
} from './recurring.store';

const COLS =
  'id, correlation_token, terminal_id, merchant_id, initial_transaction_id, amount_minor, currency, ' +
  'viva_transaction_id, error_log, status, created_at, updated_at';

function toIso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}
function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; message?: string };
  return err?.code === '23505' || /unique|duplicate key/i.test(String(err?.message ?? ''));
}
function mapRow(row: any): RecurringChargeRecord {
  return {
    id: row.id,
    correlationToken: row.correlation_token,
    terminalId: row.terminal_id,
    merchantId: row.merchant_id,
    initialTransactionId: row.initial_transaction_id,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    vivaTransactionId: row.viva_transaction_id ?? null,
    errorLog: typeof row.error_log === 'string' ? JSON.parse(row.error_log) : (row.error_log ?? null),
    status: row.status as RecurringStatus,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export class PgRecurringRepository implements RecurringRepository {
  constructor(private readonly db: Queryable) {}

  async create(c: NewRecurringCharge): Promise<RecurringChargeRecord> {
    try {
      const res = await this.db.query(
        `INSERT INTO recurring_charge
           (correlation_token, terminal_id, merchant_id, initial_transaction_id, amount_minor, currency)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING ${COLS}`,
        [c.correlationToken, c.terminalId, c.merchantId, c.initialTransactionId, c.amountMinor, c.currency],
      );
      return mapRow(res.rows[0]);
    } catch (e) {
      if (isUniqueViolation(e)) throw new DuplicateCorrelationError(c.correlationToken);
      throw e;
    }
  }

  async findByCorrelationToken(token: string): Promise<RecurringChargeRecord | null> {
    const res = await this.db.query(
      `SELECT ${COLS} FROM recurring_charge WHERE correlation_token = $1`, [token],
    );
    return res.rows.length ? mapRow(res.rows[0]) : null;
  }

  async updateStatus(id: string, patch: RecurringStatusPatch): Promise<RecurringChargeRecord> {
    const res = await this.db.query(
      `UPDATE recurring_charge SET
         status              = $2,
         viva_transaction_id = COALESCE($3, viva_transaction_id),
         error_log           = COALESCE($4::jsonb, error_log)
       WHERE id = $1
       RETURNING ${COLS}`,
      [
        id,
        patch.status,
        patch.vivaTransactionId ?? null,
        patch.errorLog !== undefined && patch.errorLog !== null ? JSON.stringify(patch.errorLog) : null,
      ],
    );
    if (res.rows.length === 0) throw new Error(`no such recurring charge ${id}`);
    return mapRow(res.rows[0]);
  }
}
