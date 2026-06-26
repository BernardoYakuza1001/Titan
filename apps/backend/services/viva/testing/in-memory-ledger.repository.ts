/**
 * In-memory LedgerRepository for unit tests. Enforces the same invariants the
 * Postgres table does: unique correlation_token (idempotency) and forward-only
 * status transitions.
 */
import { LedgerRepository, NewTransaction, LedgerStatusPatch } from '../ports';
import { TransactionRecord, FiatStatus, DuplicateCorrelationError } from '../domain';

const FORWARD: Record<FiatStatus, FiatStatus[]> = {
  FIAT_CREATED: ['FIAT_PROCESSING', 'FIAT_DECLINED'],
  FIAT_PROCESSING: ['FIAT_APPROVED', 'FIAT_DECLINED'],
  FIAT_APPROVED: [],
  FIAT_DECLINED: [],
};

export class InMemoryLedgerRepository implements LedgerRepository {
  private readonly byId = new Map<string, TransactionRecord>();
  private readonly byToken = new Map<string, string>();
  private seq = 0;

  constructor(private readonly now: () => string = () => new Date(0).toISOString()) {}

  async create(tx: NewTransaction): Promise<TransactionRecord> {
    if (this.byToken.has(tx.correlationToken)) {
      throw new DuplicateCorrelationError(tx.correlationToken);
    }
    const id = `fiat_${++this.seq}`;
    const ts = this.now();
    const record: TransactionRecord = {
      id,
      correlationToken: tx.correlationToken,
      terminalId: tx.terminalId,
      merchantId: tx.merchantId,
      amountMinor: tx.amountMinor,
      currency: tx.currency,
      maskedPan: tx.maskedPan,
      cardBrand: tx.cardBrand,
      vivaTransactionId: null,
      vivaOrderCode: null,
      authorizationCode: null,
      errorLog: null,
      status: 'FIAT_CREATED',
      createdAt: ts,
      updatedAt: ts,
    };
    this.byId.set(id, record);
    this.byToken.set(tx.correlationToken, id);
    return { ...record };
  }

  async findByCorrelationToken(token: string): Promise<TransactionRecord | null> {
    const id = this.byToken.get(token);
    return id ? { ...this.byId.get(id)! } : null;
  }

  async findById(id: string): Promise<TransactionRecord | null> {
    const r = this.byId.get(id);
    return r ? { ...r } : null;
  }

  async updateStatus(id: string, patch: LedgerStatusPatch): Promise<TransactionRecord> {
    const r = this.byId.get(id);
    if (!r) throw new Error(`no such transaction ${id}`);
    if (patch.status !== r.status && !FORWARD[r.status].includes(patch.status)) {
      throw new Error(`illegal status transition ${r.status} -> ${patch.status}`);
    }
    const updated: TransactionRecord = {
      ...r,
      status: patch.status,
      vivaTransactionId: patch.vivaTransactionId !== undefined ? patch.vivaTransactionId : r.vivaTransactionId,
      vivaOrderCode: patch.vivaOrderCode !== undefined ? patch.vivaOrderCode : r.vivaOrderCode,
      authorizationCode: patch.authorizationCode !== undefined ? patch.authorizationCode : r.authorizationCode,
      errorLog: patch.errorLog !== undefined ? patch.errorLog : r.errorLog,
      updatedAt: this.now(),
    };
    this.byId.set(id, updated);
    return { ...updated };
  }

  async findByTerminal(terminalId: string, limit: number, offset: number): Promise<TransactionRecord[]> {
    return [...this.byId.values()]
      .filter((r) => r.terminalId === terminalId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : (a.id < b.id ? 1 : -1)))
      .slice(offset, offset + limit)
      .map((r) => ({ ...r }));
  }
}
