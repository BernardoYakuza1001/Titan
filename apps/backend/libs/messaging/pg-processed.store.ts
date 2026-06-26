/**
 * PROJECT TITAN — Postgres-backed inbox dedup store (Deliverable 5/8)
 *
 * Production {@link ProcessedStore} for {@link IdempotentInboxConsumer}, backed by
 * the `inbox_processed` table (migrations/003_inbox.sql). The table's PRIMARY KEY
 * on `message_id` is the dedup guard: under a concurrent double-delivery the
 * second INSERT collides and that worker's transaction rolls back, so the
 * handler's effect applies exactly once.
 *
 * `markProcessedTx` writes the dedup row on the CALLER's `Tx`, so the dedup mark
 * and the handler's own writes commit atomically (true exactly-once). All SQL is
 * parameterized ($1, $2) — never string-interpolated.
 */
import type { Db, Tx } from '../persistence/db';
import type { ProcessedStore } from './inbox.consumer';

export class PgProcessedStore implements ProcessedStore {
  constructor(private readonly db: Db) {}

  async has(id: string): Promise<boolean> {
    const r = await this.db.query(
      'SELECT 1 FROM inbox_processed WHERE message_id = $1 LIMIT 1',
      [id],
    );
    return r.rowCount > 0;
  }

  async markProcessed(id: string, topic: string): Promise<void> {
    // ON CONFLICT DO NOTHING: a racing duplicate is silently absorbed rather than
    // raising — the row already records that this id was applied.
    await this.db.query(
      `INSERT INTO inbox_processed (message_id, topic)
       VALUES ($1, $2)
       ON CONFLICT (message_id) DO NOTHING`,
      [id, topic],
    );
  }

  async markProcessedTx(tx: Tx, id: string, topic: string): Promise<void> {
    // Inside the handler's transaction: if a concurrent worker already inserted
    // this id, the PRIMARY KEY collision aborts THIS tx, so the handler's writes
    // roll back with it — the effect lands exactly once.
    await tx.query(
      'INSERT INTO inbox_processed (message_id, topic) VALUES ($1, $2)',
      [id, topic],
    );
  }
}
