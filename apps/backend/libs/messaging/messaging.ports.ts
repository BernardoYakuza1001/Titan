/**
 * PROJECT TITAN — Messaging / Outbox ports (Deliverable 5/8)
 *
 * The transactional-outbox seam that keeps the hash-chained ledger and the Kafka
 * event stream consistent. A domain write appends a ledger event AND inserts an
 * outbox row in the SAME DB transaction (`Tx`); a separate relay later publishes
 * unpublished rows to Kafka at-least-once and marks them published. This avoids
 * dual-write loss between the database and the broker.
 *
 * These are interfaces ONLY — the Postgres outbox table, the kafkajs producer,
 * and the relay loop are implemented by the next agents against these shapes.
 */
import type { Tx } from '../persistence/db';
import type { LedgerEvent } from '../ledger/ledger.service';

/**
 * One row of the transactional outbox. Written in the same transaction as the
 * business change, drained asynchronously to the broker. `id`/`publishedAt` are
 * assigned by the store, so writers omit them (see `OutboxStore.insertTx`).
 */
export interface OutboxRecord {
  id?: string;                          // assigned by the store (uuid)
  aggregateId: string;                  // transaction id this event belongs to
  type: string;                         // domain event type (e.g. 'AUTHORIZED')
  topic: string;                        // destination Kafka topic
  key: string;                          // partition key (usually aggregateId)
  payload: Record<string, unknown>;     // event body (serialized to JSON)
  createdAt: string;                    // ISO-8601, set when the row is written
  publishedAt?: string | null;         // ISO-8601 once relayed; null while pending
  attempts?: number;                    // publish attempts (for backoff/poison detection)
}

/**
 * Persistence port for the outbox table. `insertTx` MUST run on the caller's
 * `Tx` so the row commits atomically with the ledger/projection write; the drain
 * methods are used by the relay outside that transaction.
 */
export interface OutboxStore {
  /** Insert a pending outbox row within the caller's transaction. */
  insertTx(tx: Tx, rec: Omit<OutboxRecord, 'id' | 'publishedAt'>): Promise<void>;
  /** Fetch up to `limit` rows that have not yet been published (FIFO). */
  fetchUnpublished(limit: number): Promise<OutboxRecord[]>;
  /** Mark the given rows as successfully published. */
  markPublished(ids: string[]): Promise<void>;
  /** Mark the given rows as failed (increments attempts / records for retry). */
  markFailed(ids: string[]): Promise<void>;
}

/**
 * Broker producer port (kafkajs adapter in prod). One normalized publish call so
 * the relay never learns the broker's client quirks.
 */
export interface MessageProducer {
  /** Publish a single message to `topic` partitioned by `key`. */
  publish(topic: string, key: string, value: Record<string, unknown>): Promise<void>;
}

/**
 * The background relay that moves pending outbox rows to the broker. `drainOnce`
 * performs a single batch (fetch -> publish -> mark) and is invoked on a timer.
 */
export interface OutboxRelay {
  /** Publish one batch of pending rows. Returns the number actually published. */
  drainOnce(): Promise<number>;
}

/**
 * High-level writer used by the saga: in ONE database transaction it appends the
 * ledger event (chaining from the aggregate head) AND inserts the matching
 * outbox row, returning the persisted `LedgerEvent`. This is the atomic
 * ledger+outbox primitive the orchestration layer calls instead of touching the
 * ledger store and outbox store separately.
 */
export interface LedgerOutboxWriter {
  /** Append a ledger event and enqueue its outbox row atomically. */
  record(
    aggregateId: string,
    type: string,
    payload: Record<string, unknown>,
    topic: string,
  ): Promise<LedgerEvent>;
}
