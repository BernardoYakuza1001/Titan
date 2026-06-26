/**
 * PROJECT TITAN — Postgres Db / UnitOfWork adapter (Deliverable 5)
 *
 * The ONLY place that knows about pooling and the physical
 * `BEGIN/COMMIT/ROLLBACK` ceremony. Everything else talks to {@link Db}/{@link Tx}.
 *
 * `run(fn)` checks out a client, BEGINs, runs `fn` against a {@link Tx} bound to
 * that client, COMMITs on success, ROLLBACKs on throw, and ALWAYS releases the
 * client in `finally` — so a thrown `fn` can never leak a connection.
 */
import type { Pool, PoolClient } from 'pg';
import type { Db, Tx, UnitOfWork } from './db';

/** Normalized query result shape both `Db.query` and `Tx.query` return. */
export interface QueryResult {
  rows: any[];
  rowCount: number;
}

/**
 * The minimal surface we need from a `pg`-style query executor. Both `Pool` and
 * `PoolClient` satisfy it, which is what lets {@link PgTx} wrap either.
 */
export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

/**
 * A {@link Tx} adapter around a single pg client (or any {@link Queryable}).
 * Every query issued through it runs on the SAME connection, so it participates
 * in the one in-flight transaction.
 */
export class PgTx implements Tx {
  constructor(private readonly client: Queryable) {}

  async query(sql: string, params: unknown[] = []): Promise<QueryResult> {
    const res = await this.client.query(sql, params);
    return { rows: res.rows, rowCount: res.rowCount ?? res.rows.length };
  }
}

/**
 * Concrete {@link Db} over a node-postgres {@link Pool}.
 *
 * `query` runs auto-commit statements straight on the pool (the pool checks out,
 * runs, and returns a client for us). `run` checks out a dedicated client for
 * the transaction boundary.
 */
export class PgDb implements Db, UnitOfWork {
  constructor(private readonly pool: Pool) {}

  /** Auto-commit query outside any explicit transaction. */
  async query(sql: string, params: unknown[] = []): Promise<QueryResult> {
    const res = await this.pool.query(sql, params);
    return { rows: res.rows, rowCount: res.rowCount ?? res.rows.length };
  }

  /**
   * Execute `fn` inside a single transaction. Resolves with `fn`'s value after
   * COMMIT; rejects after ROLLBACK if `fn` (or COMMIT) throws. The client is
   * released in `finally` either way — no connection leaks.
   */
  async run<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const client: PoolClient = await this.pool.connect();
    const tx = new PgTx(client);
    try {
      await client.query('BEGIN');
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // A failed ROLLBACK (e.g. broken connection) must not mask the original
        // error; the client is discarded on release below.
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /** Release the underlying pool. */
  async close(): Promise<void> {
    await this.pool.end();
  }
}
