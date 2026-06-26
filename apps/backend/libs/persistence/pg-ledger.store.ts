/**
 * PROJECT TITAN — Postgres ledger store (Deliverable 5)
 *
 * Append-only persistence for the hash-chained ledger. It STORES the
 * `prevHash`/`hash` it is handed and NEVER recomputes them — the chaining +
 * canonical-hash contract lives entirely in ledger.service. This store's only
 * job is durable, ordered persistence of pre-hashed events.
 *
 * Implements {@link TxAwareLedgerStore}: `append`/`lastHash` open their own
 * auto-commit query; `appendTx`/`lastHashTx` run on the caller's {@link Tx} so a
 * ledger append commits atomically with its outbox row (the outbox pattern).
 */
import type { Db, Tx } from './db';
import type { LedgerEvent } from '../ledger/ledger.service';
import type { TxAwareLedgerStore } from './repository.contracts';

interface LedgerRow {
  seq: string | number;
  aggregate_id: string;
  type: string;
  payload: Record<string, unknown>;
  prev_hash: string;
  hash: string;
  created_at: Date | string;
}

/** A {@link Tx} or the {@link Db} both satisfy this — lets one helper serve both paths. */
interface Executor {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number }>;
}

const LAST_HASH_SQL = `
  SELECT hash
    FROM ledger_events
   WHERE aggregate_id = $1
   ORDER BY seq DESC
   LIMIT 1
`;

const APPEND_SQL = `
  INSERT INTO ledger_events (aggregate_id, type, payload, prev_hash, hash, created_at)
  VALUES ($1, $2, $3, $4, $5, $6)
`;

export class PgLedgerStore implements TxAwareLedgerStore {
  constructor(private readonly db: Db) {}

  async lastHash(aggregateId: string): Promise<string | null> {
    return this.lastHashOn(this.db, aggregateId);
  }

  async lastHashTx(tx: Tx, aggregateId: string): Promise<string | null> {
    return this.lastHashOn(tx, aggregateId);
  }

  async append(event: LedgerEvent): Promise<void> {
    await this.appendOn(this.db, event);
  }

  async appendTx(tx: Tx, event: LedgerEvent): Promise<void> {
    await this.appendOn(tx, event);
  }

  async list(aggregateId: string): Promise<LedgerEvent[]> {
    const res = await this.db.query(
      `SELECT seq, aggregate_id, type, payload, prev_hash, hash, created_at
         FROM ledger_events
        WHERE aggregate_id = $1
        ORDER BY seq ASC`,
      [aggregateId],
    );
    return res.rows.map((r) => this.toEvent(r as LedgerRow));
  }

  // ---- shared implementations (work on Db or Tx) ----

  private async lastHashOn(exec: Executor, aggregateId: string): Promise<string | null> {
    const res = await exec.query(LAST_HASH_SQL, [aggregateId]);
    return res.rows.length ? (res.rows[0].hash as string) : null;
  }

  private async appendOn(exec: Executor, event: LedgerEvent): Promise<void> {
    await exec.query(APPEND_SQL, [
      event.aggregateId,
      event.type,
      // node-postgres serializes objects to jsonb automatically; do it explicitly
      // so behavior is identical under pg-mem.
      JSON.stringify(event.payload),
      event.prevHash,
      event.hash,
      event.createdAt,
    ]);
  }

  private toEvent(row: LedgerRow): LedgerEvent {
    return {
      seq: typeof row.seq === 'string' ? Number(row.seq) : row.seq,
      aggregateId: row.aggregate_id,
      type: row.type,
      payload: parseJson(row.payload),
      prevHash: row.prev_hash,
      hash: row.hash,
      createdAt:
        row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    };
  }
}

/** jsonb may arrive parsed (pg) or as a string (some drivers / pg-mem paths). */
function parseJson(value: unknown): Record<string, unknown> {
  if (value == null) return {};
  if (typeof value === 'string') return JSON.parse(value);
  return value as Record<string, unknown>;
}
