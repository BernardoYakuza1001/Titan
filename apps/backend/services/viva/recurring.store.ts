/**
 * PROJECT TITAN — recurring (MIT) charge store (DRIVEN port + domain).
 *
 * Audit of merchant-initiated charges chained off an initial AUTHENTICATED
 * transaction. No card data — only Viva ids + money. Forward-only / idempotent.
 */

export type RecurringStatus = 'RECURRING_CREATED' | 'RECURRING_APPROVED' | 'RECURRING_DECLINED';

export interface RecurringChargeRecord {
  id: string;
  correlationToken: string;
  terminalId: string;
  merchantId: string;
  initialTransactionId: string;
  amountMinor: number;
  currency: string;
  vivaTransactionId: string | null;
  errorLog: Record<string, unknown> | null;
  status: RecurringStatus;
  createdAt: string;
  updatedAt: string;
}

export interface NewRecurringCharge {
  correlationToken: string;
  terminalId: string;
  merchantId: string;
  initialTransactionId: string;
  amountMinor: number;
  currency: string;
}

export interface RecurringStatusPatch {
  status: RecurringStatus;
  vivaTransactionId?: string | null;
  errorLog?: Record<string, unknown> | null;
}

export interface RecurringRepository {
  /** Insert a RECURRING_CREATED row. Throws DuplicateCorrelationError on token conflict. */
  create(c: NewRecurringCharge): Promise<RecurringChargeRecord>;
  findByCorrelationToken(token: string): Promise<RecurringChargeRecord | null>;
  /** Apply a forward-only status patch (DB trigger also enforces this). */
  updateStatus(id: string, patch: RecurringStatusPatch): Promise<RecurringChargeRecord>;
}
