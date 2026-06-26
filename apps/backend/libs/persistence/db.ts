/**
 * PROJECT TITAN — Persistence primitives (Deliverable 5)
 *
 * The narrow database seam every repository and the outbox writer depend on.
 * Implementations wrap a real Postgres pool (`pg`); tests can substitute an
 * in-memory fake (`pg-mem`). Keeping these interfaces tiny means the persistence
 * adapter is the ONLY place that knows about connections, pooling, and the
 * physical `BEGIN/COMMIT/ROLLBACK` ceremony.
 */

/**
 * A handle bound to a single in-flight database transaction. Every query issued
 * through a `Tx` participates in the SAME transaction, so a ledger append and
 * its projection/outbox write either all commit or all roll back together
 * (the outbox pattern's atomicity guarantee).
 */
export interface Tx {
  /** Execute a parameterized SQL statement within this transaction. */
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number }>;
}

/**
 * Runs a unit of work inside a transaction boundary. The implementation issues
 * `BEGIN` before `fn`, `COMMIT` if it resolves, and `ROLLBACK` if it throws —
 * the caller never writes those keywords by hand.
 */
export interface UnitOfWork {
  /**
   * Execute `fn` inside a single DB transaction. Resolves with `fn`'s result on
   * commit; rejects (after rollback) if `fn` throws.
   */
  run<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}

/**
 * The full database port: ad-hoc (auto-commit) queries for simple reads,
 * transactional units of work for money-moving writes, and lifecycle close.
 */
export interface Db extends UnitOfWork {
  /** Execute a parameterized SQL statement outside an explicit transaction. */
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number }>;
  /** Release the underlying pool/connection. */
  close(): Promise<void>;
}
