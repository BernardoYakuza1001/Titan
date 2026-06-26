/**
 * PROJECT TITAN — Postgres LedgerRepository (DRIVEN/infrastructure).
 * Maps the fiat_transaction_log table (010 migration). Parameterized SQL only.
 * The DB triggers independently enforce immutability + forward-only status, so a
 * bug here cannot corrupt history.
 */
import { LedgerRepository, NewTransaction, LedgerStatusPatch } from './ports';
import { TransactionRecord, CardBrand, FiatStatus, DuplicateCorrelationError } from './domain';

/** Minimal query surface (a pg Pool/client or the persistence Db both satisfy it). */
export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

const COLS =
  'id, correlation_token, terminal_id, merchant_id, amount_minor, currency, masked_pan, ' +
  'card_brand, viva_transaction_id, viva_order_code, authorization_code, error_log, status, ' +
  'created_at, updated_at';

function toIso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

/** Postgres unique-violation is SQLSTATE 23505; pg-mem surfaces it in the message. */
function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; message?: string };
  return err?.code === '23505' || /unique|duplicate key/i.test(String(err?.message ?? ''));
}

function mapRow(row: any): TransactionRecord {
  return {
    id: row.id,
    correlationToken: row.correlation_token,
    terminalId: row.terminal_id,
    merchantId: row.merchant_id,
    amountMinor: Number(row.amount_minor),         // bigint comes back as string
    currency: row.currency,
    maskedPan: row.masked_pan,
    cardBrand: row.card_brand as CardBrand,
    vivaTransactionId: row.viva_transaction_id ?? null,
    vivaOrderCode: row.viva_order_code ?? null,
    authorizationCode: row.authorization_code ?? null,
    errorLog: typeof row.error_log === 'string' ? JSON.parse(row.error_log) : (row.error_log ?? null),
    status: row.status as FiatStatus,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export class PgLedgerRepository implements LedgerRepository {
  constructor(private readonly db: Queryable) {}

  async create(tx: NewTransaction): Promise<TransactionRecord> {
    // Insert then translate a unique(correlation_token) violation into the domain
    // error. Portable: real Postgres raises SQLSTATE 23505 on the duplicate, which
    // the application layer turns into idempotent return of the original record.
    try {
      const res = await this.db.query(
        `INSERT INTO fiat_transaction_log
           (correlation_token, terminal_id, merchant_id, amount_minor, currency, masked_pan, card_brand)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING ${COLS}`,
        [tx.correlationToken, tx.terminalId, tx.merchantId, tx.amountMinor, tx.currency, tx.maskedPan, tx.cardBrand],
      );
      return mapRow(res.rows[0]);
    } catch (e) {
      if (isUniqueViolation(e)) throw new DuplicateCorrelationError(tx.correlationToken);
      throw e;
    }
  }

  async findByCorrelationToken(token: string): Promise<TransactionRecord | null> {
    const res = await this.db.query(
      `SELECT ${COLS} FROM fiat_transaction_log WHERE correlation_token = $1`, [token],
    );
    return res.rows.length ? mapRow(res.rows[0]) : null;
  }

  async findById(id: string): Promise<TransactionRecord | null> {
    const res = await this.db.query(`SELECT ${COLS} FROM fiat_transaction_log WHERE id = $1`, [id]);
    return res.rows.length ? mapRow(res.rows[0]) : null;
  }

  async updateStatus(id: string, patch: LedgerStatusPatch): Promise<TransactionRecord> {
    // COALESCE keeps existing values when a field is not part of this patch.
    const res = await this.db.query(
      `UPDATE fiat_transaction_log SET
         status              = $2,
         viva_transaction_id = COALESCE($3, viva_transaction_id),
         viva_order_code     = COALESCE($4, viva_order_code),
         authorization_code  = COALESCE($5, authorization_code),
         error_log           = COALESCE($6::jsonb, error_log)
       WHERE id = $1
       RETURNING ${COLS}`,
      [
        id,
        patch.status,
        patch.vivaTransactionId ?? null,
        patch.vivaOrderCode ?? null,
        patch.authorizationCode ?? null,
        patch.errorLog !== undefined && patch.errorLog !== null ? JSON.stringify(patch.errorLog) : null,
      ],
    );
    if (res.rows.length === 0) throw new Error(`no such transaction ${id}`);
    return mapRow(res.rows[0]);
  }

  async findByTerminal(terminalId: string, limit: number, offset: number): Promise<TransactionRecord[]> {
    const res = await this.db.query(
      `SELECT ${COLS} FROM fiat_transaction_log
       WHERE terminal_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT $2 OFFSET $3`,
      [terminalId, limit, offset],
    );
    return res.rows.map(mapRow);
  }
}
