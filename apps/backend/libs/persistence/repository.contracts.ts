/**
 * PROJECT TITAN — Repository contracts (Deliverable 5)
 *
 * The single seam between the domain services and the Postgres persistence
 * adapter. Each port below is OWNED by a domain module (re-exported here so the
 * persistence layer has one import surface) and is implemented by a `Pg*` class
 * in this directory.
 *
 * Where a write must commit atomically with the transactional outbox (the
 * ledger append is the canonical example), the port also exposes a `*Tx`
 * variant that runs on a caller-supplied {@link Tx}. The non-Tx methods open
 * their own auto-commit query via {@link Db}; the `*Tx` methods join the
 * caller's `BEGIN/COMMIT` so the ledger row and its outbox row share one fate.
 */
import type { Tx } from './db';
import type { LedgerEvent, LedgerStore } from '../ledger/ledger.service';
import type { TransactionContext, TxRepo, CasePort } from '../../services/transaction/transaction.saga';
import type { ProfileRepo } from '../../services/profile/profile-resolver.service';
import type { RouteStore, RouteCandidate } from '../../services/payment/payment-router.service';
import type { AuthRefStore } from '../../services/payment/auth-engine.service';
import type { ComplianceCaseStore } from '../../services/compliance/compliance-engine.service';

// Re-export the domain-owned ports so callers depend on ONE module.
export type {
  LedgerEvent,
  LedgerStore,
  TransactionContext,
  TxRepo,
  CasePort,
  ProfileRepo,
  RouteStore,
  RouteCandidate,
  AuthRefStore,
  ComplianceCaseStore,
};

/**
 * The transaction lookup port consumed by the transaction controller. Kept here
 * (identical shape to the controller's private interface) so the persistence
 * implementation has a name to conform to. `PgTxRepo` satisfies both this and
 * {@link TxRepo}.
 */
export interface TxLookup {
  byIdempotencyKey(key: string): Promise<TransactionContext | null>;
  create(ctx: TransactionContext): Promise<void>;
  byId(id: string): Promise<TransactionContext | null>;
}

/**
 * The full transaction repository surface: the saga's writer ({@link TxRepo}),
 * the controller's reads/creates ({@link TxLookup}), plus an explicit upsert.
 */
export interface TransactionRepository extends TxRepo, TxLookup {
  /** Insert-or-update by id (idempotent persistence of a saga transition). */
  save(ctx: TransactionContext): Promise<void>;
}

/**
 * Ledger store extended with transaction-aware variants. `append`/`lastHash`
 * own their connection (auto-commit); `appendTx`/`lastHashTx` run on the
 * caller's `Tx` so a ledger append commits atomically with the outbox insert.
 *
 * IMPORTANT: implementations PERSIST the `prevHash`/`hash` they are given — they
 * never recompute the chain (the hashing contract lives in ledger.service).
 */
export interface TxAwareLedgerStore extends LedgerStore {
  /** Current head hash for an aggregate within the caller's transaction. */
  lastHashTx(tx: Tx, aggregateId: string): Promise<string | null>;
  /** Append a pre-hashed event within the caller's transaction. */
  appendTx(tx: Tx, event: LedgerEvent): Promise<void>;
}

/**
 * The treasury reconciliation case port the saga depends on for post-commit
 * failures. Implemented by `PgTreasuryCaseStore`.
 */
export type TreasuryCaseStore = CasePort;
