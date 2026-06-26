/**
 * PROJECT TITAN — Persistence barrel (Deliverable 5)
 *
 * One import surface for the persistence adapter: the database seam, the
 * repository contracts, every Postgres repository implementation, and the
 * migration runner.
 */

// ---- database seam (ports) ----
export type { Db, Tx, UnitOfWork } from './db';

// ---- repository contracts ----
export * from './repository.contracts';

// ---- Db / UnitOfWork implementation over node-postgres ----
export { PgDb, PgTx } from './pg-db';
export type { QueryResult, Queryable } from './pg-db';

// ---- repository implementations ----
export { PgLedgerStore } from './pg-ledger.store';
export { PgTxRepo } from './pg-transaction.repo';
export { PgAuthRefStore, PgRouteStore } from './pg-payment.stores';
export { PgComplianceCaseStore, PgTreasuryCaseStore } from './pg-case.stores';
export { PgProfileRepo } from './pg-profile.repo';

// ---- migration runner ----
export {
  migrate,
  migrateInTx,
  splitStatements,
  listMigrationFiles,
} from './migrate';
export type { MigrateOptions, SqlExecutor } from './migrate';
