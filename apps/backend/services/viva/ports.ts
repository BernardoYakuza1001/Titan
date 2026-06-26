/**
 * PROJECT TITAN — Phase 1 fiat acquiring — PORTS (interfaces).
 * Driving (inbound) + driven (outbound) boundaries of the hexagon.
 */
import {
  PaymentIntent, ChargeOutcome, TransactionRecord, FiatStatus, CardBrand,
} from './domain';

// ---- DRIVEN (outbound) ------------------------------------------------------

/** The acquirer. Charges a single-use token with MOTO / card-not-present semantics. */
export interface AcquiringGateway {
  charge(intent: PaymentIntent): Promise<ChargeOutcome>;
}

export interface NewTransaction {
  correlationToken: string;
  terminalId: string;
  merchantId: string;
  amountMinor: number;
  currency: string;
  maskedPan: string;
  cardBrand: CardBrand;
}

export interface LedgerStatusPatch {
  status: FiatStatus;
  vivaTransactionId?: string | null;
  vivaOrderCode?: string | null;
  authorizationCode?: string | null;
  errorLog?: Record<string, unknown> | null;
}

/** Persistence of the immutable ledger (fiat_transaction_log). */
export interface LedgerRepository {
  /** Insert a FIAT_CREATED row. Throws DuplicateCorrelationError on token conflict. */
  create(tx: NewTransaction): Promise<TransactionRecord>;
  findByCorrelationToken(token: string): Promise<TransactionRecord | null>;
  findById(id: string): Promise<TransactionRecord | null>;
  /** Apply a forward-only status patch (DB trigger also enforces this). */
  updateStatus(id: string, patch: LedgerStatusPatch): Promise<TransactionRecord>;
  /** Terminal-scoped history, newest first. */
  findByTerminal(terminalId: string, limit: number, offset: number): Promise<TransactionRecord[]>;
}

// ---- DRIVING (inbound) ------------------------------------------------------

export interface ProcessMotoPaymentUseCase {
  process(intent: PaymentIntent): Promise<TransactionRecord>;
}

export interface QueryTerminalHistoryUseCase {
  byTerminal(terminalId: string, limit: number, offset: number): Promise<TransactionRecord[]>;
}
