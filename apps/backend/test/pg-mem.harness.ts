/**
 * PROJECT TITAN — Shared pg-mem test harness (integration tests)
 *
 * Builds an in-memory Postgres (pg-mem, no Docker), exposes it as a `pg`-style
 * Pool, and applies the real numbered migrations via the production `migrate()`
 * runner. Repositories and the outbox writer/relay run against the SAME `Db` /
 * `Tx` / `UnitOfWork` contract they use in production.
 *
 * pg-mem accommodations (all isolated HERE so production code is untouched):
 *
 *   1. ROLLBACK isolation. pg-mem's `createPg()` Pool does NOT isolate
 *      transactions across `pool.connect()` clients — its `BEGIN`/`ROLLBACK` are
 *      effectively no-ops, so a thrown unit-of-work would otherwise leave partial
 *      writes behind (which would silently mask the outbox atomicity guarantee).
 *      pg-mem DOES support true rollback via `IMemoryDb.backup()/restore()`. The
 *      `MemDb` adapter below implements `UnitOfWork.run` with a snapshot taken
 *      before the work and restored if it throws — giving the real
 *      commit/rollback semantics the production `PgDb` gets from Postgres MVCC.
 *      All queries inside a `run` go through the same single pg-mem backend, so a
 *      restore cleanly undoes them. (The production adapter is `PgDb` in
 *      libs/persistence/pg-db.ts; this harness mirrors its contract.)
 *
 *   2. `FOR UPDATE SKIP LOCKED` is unsupported by pg-mem, so callers that build a
 *      `PgOutboxStore` pass `{ useSkipLocked: false }` (production defaults true).
 *
 *   3. No `gen_random_uuid()` default is needed: the application assigns every
 *      uuid id (the `migrate()` runner also skips `CREATE EXTENSION`).
 */
import { newDb, DataType, type IMemoryDb } from 'pg-mem';
import * as path from 'path';
import { migrate } from '../libs/persistence/migrate';
import type { Db, Tx, UnitOfWork } from '../libs/persistence/db';

/** Absolute path to the migrations directory (resolved from this test file). */
export const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations');

interface PgLikePool {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
  end?(): Promise<void>;
}

/**
 * A {@link Db} over a pg-mem backend. Mirrors the production `PgDb` contract but
 * implements transaction rollback with pg-mem's snapshot/restore (see harness
 * docs above) because pg-mem's pooled-client BEGIN/ROLLBACK does not isolate.
 */
class MemDb implements Db, UnitOfWork {
  constructor(
    private readonly mem: IMemoryDb,
    private readonly pool: PgLikePool,
  ) {}

  async query(sql: string, params: unknown[] = []): Promise<{ rows: any[]; rowCount: number }> {
    const res = await this.pool.query(sql, params);
    return { rows: res.rows, rowCount: res.rowCount ?? res.rows.length };
  }

  async run<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    // Snapshot BEFORE the work; restore on throw == ROLLBACK, keep == COMMIT.
    const snapshot = this.mem.backup();
    const tx: Tx = {
      query: async (sql: string, params: unknown[] = []) => {
        const res = await this.pool.query(sql, params);
        return { rows: res.rows, rowCount: res.rowCount ?? res.rows.length };
      },
    };
    try {
      const result = await fn(tx);
      return result; // commit: simply drop the snapshot
    } catch (err) {
      snapshot.restore(); // rollback: undo every write made inside fn
      throw err;
    }
  }

  async close(): Promise<void> {
    if (this.pool.end) await this.pool.end();
  }
}

/**
 * Create a fresh pg-mem database exposed through a {@link Db} adapter with real
 * commit/rollback semantics. Each call is fully isolated (new in-memory engine).
 */
export function newPgDb(): Db {
  const mem = newDb({ autoCreateForeignKeyIndices: true });
  registerPgStubs(mem);
  const pgAdapter = mem.adapters.createPg();
  const pool = new pgAdapter.Pool() as PgLikePool;
  return new MemDb(mem, pool);
}

/**
 * Register the few native Postgres functions the production code calls that
 * pg-mem does not implement. Today that is the per-aggregate serialization lock
 * `pg_advisory_xact_lock(hashtext($1))` taken by LedgerOutboxWriter.record().
 *
 * pg-mem is single-threaded, so an advisory lock is a no-op here — but the
 * function must still EXIST or the query throws. `hashtext` returns a deterministic
 * 32-bit hash; `pg_advisory_xact_lock` is a no-op returning 0 (its value is
 * ignored). This keeps the production SQL path identical under tests.
 */
function registerPgStubs(mem: IMemoryDb): void {
  mem.public.registerFunction({
    name: 'hashtext',
    args: [DataType.text],
    returns: DataType.integer,
    implementation: (s: string) => {
      let h = 0;
      const str = String(s);
      for (let i = 0; i < str.length; i++) {
        h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
      }
      return h;
    },
  });
  mem.public.registerFunction({
    name: 'pg_advisory_xact_lock',
    args: [DataType.integer],
    returns: DataType.integer,
    implementation: () => 0,
  });
}

/** Apply every migration file (in order) against the given Db. Returns count. */
export async function applyMigrations(db: Db): Promise<number> {
  // 010_viva_fiat_acquiring.sql and 011_viva_checkout_orders.sql use plpgsql
  // triggers + regex CHECKs that pg-mem cannot run. Those fiat-acquiring contexts
  // are verified against real Postgres and via their own pg-mem-shaped tables in
  // viva-ledger-pg.spec.ts / viva-order-repo-pg.spec.ts, so they are excluded
  // from this crypto-side harness.
  return migrate(db, {
    dir: MIGRATIONS_DIR,
    excludeFiles: [
      '010_viva_fiat_acquiring.sql', '011_viva_checkout_orders.sql', '012_recurring_charge.sql',
      '013_recurring_processing_enum.sql', '014_recurring_processing_guard.sql',
    ],
  });
}
