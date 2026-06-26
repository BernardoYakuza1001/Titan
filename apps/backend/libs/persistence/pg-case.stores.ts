/**
 * PROJECT TITAN — Postgres case stores (Deliverable 5)
 *
 *   * PgComplianceCaseStore — implements ComplianceCaseStore: opens a COMPLIANCE
 *     case when a blocking gate fails (reasons[] persisted as jsonb notes).
 *   * PgTreasuryCaseStore   — implements CasePort: opens a
 *     TREASURY_RECONCILIATION case for post-commit / void failures so funds are
 *     never silently lost (detail object persisted as jsonb notes).
 *
 * Both persist to `compliance_cases`, discriminated by the `type` column.
 */
import { randomUUID } from 'crypto';
import type { Db } from './db';
import type { ComplianceCaseStore } from '../../services/compliance/compliance-engine.service';
import type { CasePort } from '../../services/transaction/transaction.saga';

const INSERT_CASE_SQL = `
  INSERT INTO compliance_cases (id, txn_id, type, status, notes)
  VALUES ($1, $2, $3, $4, $5)
`;

export class PgComplianceCaseStore implements ComplianceCaseStore {
  constructor(private readonly db: Db) {}

  async open(txnId: string, reasons: string[]): Promise<void> {
    await this.db.query(INSERT_CASE_SQL, [
      randomUUID(),
      txnId,
      'COMPLIANCE',
      'OPEN',
      JSON.stringify({ reasons }),
    ]);
  }
}

/** CasePort adapter — treasury reconciliation cases (post-commit safety net). */
export class PgTreasuryCaseStore implements CasePort {
  constructor(private readonly db: Db) {}

  async openTreasuryReconciliation(
    txnId: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    await this.db.query(INSERT_CASE_SQL, [
      randomUUID(),
      txnId,
      'TREASURY_RECONCILIATION',
      'OPEN',
      JSON.stringify(detail),
    ]);
  }
}
