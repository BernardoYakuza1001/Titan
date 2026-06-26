/**
 * PROJECT TITAN — Postgres transactional-outbox store (Deliverable 5/8)
 *
 * Implements {@link OutboxStore}. The whole point of this table is to make the
 * "emit an event" side-effect ATOMIC with the business write: `insertTx` runs on
 * the CALLER's `Tx`, so the outbox row commits in the very same transaction as
 * the ledger append. If the transaction rolls back, the event was never enqueued
 * — there is no window in which the DB and the broker can disagree (no dual write).
 *
 * The relay later drains pending rows with `fetchUnpublished` (in strict `seq`
 * order) and flips them via `markPublished` / `markFailed`.
 *
 * CONCURRENCY / WORKER MODEL — IMPORTANT:
 * The drain methods run through `this.db.query(...)`, i.e. a POOL auto-commit
 * statement (see PgDb.query). Each statement therefore executes in its own
 * implicit transaction, so any `FOR UPDATE SKIP LOCKED` row locks taken by the
 * SELECT are released the instant the SELECT returns — long before publish/
 * markPublished run. That means SKIP LOCKED here does NOT lease rows across the
 * fetch -> publish -> mark window and provides NO cross-worker protection: two
 * relay workers would both fetch and both publish the same pending rows. This
 * store is therefore intended to be driven by a SINGLE relay worker. The
 * `useSkipLocked` flag below merely keeps the SELECT well-behaved on production
 * Postgres (and is disabled under pg-mem, which lacks the clause); it is NOT a
 * substitute for a durable lease. Real multi-worker leasing would require running
 * fetch+publish+mark inside one shared transaction, or a claim-then-publish
 * `UPDATE ... RETURNING` — neither of which this per-statement design implements.
 *
 * Actual table (owned by the persistence/migrations agent — migrations/002_outbox.sql):
 *
 *   CREATE TABLE outbox (
 *     id            uuid        PRIMARY KEY,          -- assigned by the app (no DB default)
 *     seq           bigserial   NOT NULL,             -- monotonic FIFO order
 *     aggregate_id  uuid        NOT NULL,             -- transaction id
 *     type          text        NOT NULL,
 *     topic         text        NOT NULL,
 *     key           text        NOT NULL,
 *     payload       jsonb       NOT NULL,
 *     created_at    timestamptz NOT NULL DEFAULT now(),
 *     published_at  timestamptz NULL,
 *     attempts      int         NOT NULL DEFAULT 0
 *   );
 *   CREATE INDEX ix_outbox_published_seq ON outbox (published_at, seq);
 *
 * NOTE: `id` has NO database default, so `insertTx` assigns a uuid before insert
 * (keeps the schema pg-mem-portable: no pgcrypto/uuid-ossp extension required).
 *
 * All SQL here is parameterized ($1, $2, ...) — never string-interpolated.
 */
import { randomUUID } from 'crypto';
import type { Tx } from '../persistence/db';
import type { Db } from '../persistence/db';
import type { OutboxRecord, OutboxStore } from './messaging.ports';

/** Raw row shape as returned by the `outbox` table (snake_case columns). */
interface OutboxRow {
  id: string;
  aggregate_id: string;
  type: string;
  topic: string;
  key: string;
  payload: Record<string, unknown>;
  created_at: string | Date;
  published_at: string | Date | null;
  attempts: number;
}

/** Minimal query surface the drain methods need outside an explicit Tx. */
export interface OutboxQueryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number }>;
}

export interface PgOutboxStoreOptions {
  /**
   * Append `FOR UPDATE SKIP LOCKED` to the fetch SELECT. Default `true` on
   * production Postgres; tests on `pg-mem` set it `false` (the engine lacks the
   * clause). NOTE: because the SELECT auto-commits (see the class header), these
   * locks are released as soon as the SELECT returns and do NOT lease rows for
   * the publish window — this store assumes a single relay worker. The flag only
   * keeps the SELECT well-formed on real Postgres; it is not a leasing mechanism.
   */
  useSkipLocked?: boolean;
  /**
   * How `markPublished`/`markFailed` match a batch of ids.
   *   - `'array'` (default): `id = ANY($1::uuid[])` — one bound array param, the
   *     idiomatic + efficient production Postgres form.
   *   - `'in-list'`: expands to `id IN ($1, $2, …)` with one bound param per id.
   *     Equivalent semantics; used under `pg-mem`, whose query planner does not
   *     match `ANY(<array param>)` against a uuid column. Still fully
   *     parameterized — never string-interpolates the ids.
   */
  arrayPredicate?: 'array' | 'in-list';
}

export class PgOutboxStore implements OutboxStore {
  private readonly useSkipLocked: boolean;
  private readonly arrayPredicate: 'array' | 'in-list';

  /**
   * @param db   ambient (auto-commit) query surface used by the relay's drain
   *             methods. `insertTx` ignores this and uses the caller's `Tx`.
   * @param opts feature flags; see {@link PgOutboxStoreOptions}.
   */
  constructor(
    private readonly db: OutboxQueryable | Db,
    opts: PgOutboxStoreOptions = {},
  ) {
    this.useSkipLocked = opts.useSkipLocked ?? true;
    this.arrayPredicate = opts.arrayPredicate ?? 'array';
  }

  /**
   * Insert a pending outbox row WITHIN the caller's transaction. The `id` (uuid)
   * is assigned by the APPLICATION here — the `outbox.id` column is a plain
   * `uuid PRIMARY KEY` with NO database default (deliberately, so the schema is
   * pg-mem-portable and needs no pgcrypto/uuid-ossp extension). `published_at`
   * stays NULL (= pending) and `attempts` starts at 0. Atomic with whatever else
   * the caller did on this same `tx`.
   */
  async insertTx(
    tx: Tx,
    rec: Omit<OutboxRecord, 'id' | 'publishedAt'>,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO outbox (id, aggregate_id, type, topic, key, payload, created_at, attempts)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
      [
        randomUUID(),
        rec.aggregateId,
        rec.type,
        rec.topic,
        rec.key,
        JSON.stringify(rec.payload),
        rec.createdAt,
        rec.attempts ?? 0,
      ],
    );
  }

  /**
   * Fetch up to `limit` un-published rows in strict FIFO order by `seq`.
   *
   * Ordering is by the monotonic `seq` bigserial ONLY. `created_at` is an
   * app-supplied millisecond clock and `id` is a random uuid, so neither is a
   * safe tiebreak: two same-millisecond events for one aggregate could otherwise
   * publish out of order and overtake each other on the same Kafka partition.
   * `seq` reflects true insertion order and preserves per-aggregate event order
   * downstream.
   *
   * `FOR UPDATE SKIP LOCKED` is appended on production Postgres (omitted under
   * pg-mem). See the class header: it does NOT lease rows across the publish
   * window with this auto-commit design — this store assumes a single relay.
   */
  async fetchUnpublished(limit: number): Promise<OutboxRecord[]> {
    const lockClause = this.useSkipLocked ? ' FOR UPDATE SKIP LOCKED' : '';
    const { rows } = await this.db.query(
      `SELECT id, aggregate_id, type, topic, key, payload, created_at, published_at, attempts
         FROM outbox
        WHERE published_at IS NULL
        ORDER BY seq ASC
        LIMIT $1${lockClause}`,
      [limit],
    );
    return (rows as OutboxRow[]).map(toRecord);
  }

  /**
   * Mark rows as successfully published (sets published_at = now()). Idempotent:
   * re-marking an already-published row is a harmless no-op, and we only touch
   * rows that are still pending so a late ACK never resurrects a row.
   */
  async markPublished(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const { clause, params } = this.idMatch(ids);
    await this.db.query(
      `UPDATE outbox
          SET published_at = now()
        WHERE ${clause}
          AND published_at IS NULL`,
      params,
    );
  }

  /**
   * Record a failed publish attempt: bump `attempts` (for backoff / poison
   * detection) without setting `published_at`, so the row is retried on the next
   * drain. Only pending rows are touched.
   */
  async markFailed(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const { clause, params } = this.idMatch(ids);
    await this.db.query(
      `UPDATE outbox
          SET attempts = attempts + 1
        WHERE ${clause}
          AND published_at IS NULL`,
      params,
    );
  }

  /**
   * Build the `id`-matching predicate + bound params for a batch of ids,
   * honoring {@link PgOutboxStoreOptions.arrayPredicate}. Both forms are fully
   * parameterized; ids are NEVER interpolated into SQL.
   */
  private idMatch(ids: string[]): { clause: string; params: unknown[] } {
    if (this.arrayPredicate === 'in-list') {
      const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
      return { clause: `id IN (${placeholders})`, params: ids };
    }
    return { clause: `id = ANY($1::uuid[])`, params: [ids] };
  }
}

/** Map a raw DB row to the port's camelCase `OutboxRecord`. */
function toRecord(row: OutboxRow): OutboxRecord {
  return {
    id: row.id,
    aggregateId: row.aggregate_id,
    type: row.type,
    topic: row.topic,
    key: row.key,
    payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
    createdAt: toIso(row.created_at),
    publishedAt: row.published_at == null ? null : toIso(row.published_at),
    attempts: row.attempts,
  };
}

function toIso(v: string | Date): string {
  return v instanceof Date ? v.toISOString() : v;
}
