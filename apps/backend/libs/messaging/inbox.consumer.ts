/**
 * PROJECT TITAN — Idempotent inbox consumer (Deliverable 5/8)
 *
 * The relay is at-least-once, so a consumer WILL occasionally see the same event
 * twice (publish succeeded but the relay crashed before markPublished). This
 * helper turns at-least-once delivery into an exactly-once EFFECT: it records
 * each processed message id in a dedup ("inbox") table and skips any id it has
 * already applied, so the handler's side effect runs at most once per event.
 *
 * The natural dedup key is the ledger event `hash` (globally unique and stable),
 * falling back to the outbox row `id`. For TRUE exactly-once the dedup insert and
 * the handler's own writes should share one transaction; this helper exposes a
 * `runInTx` hook so a caller with a UnitOfWork can bind them. Without it, you get
 * at-least-once handler invocation with idempotent application (still correct for
 * idempotent handlers).
 *
 * Expected dedup table (owned by the persistence/migrations agent):
 *
 *   CREATE TABLE inbox_processed (
 *     message_id   text        PRIMARY KEY,   -- ledger event hash (or outbox id)
 *     topic        text        NOT NULL,
 *     processed_at timestamptz NOT NULL DEFAULT now()
 *   );
 *
 * The PRIMARY KEY is the dedup guard: a concurrent double-delivery makes the
 * second INSERT fail on the unique constraint, so only one worker applies it.
 */
import type { Tx } from '../persistence/db';

/** A message handed to the consumer (decoded from a Kafka record). */
export interface InboxMessage {
  /** Stable unique id — prefer the ledger event hash; else the outbox row id. */
  id: string;
  topic: string;
  payload: Record<string, unknown>;
}

/**
 * Dedup store the consumer checks before applying a handler. A Postgres
 * implementation backs `inbox_processed`; tests can use the in-memory version
 * below. `markProcessedTx` exists so the dedup write can join the handler's
 * transaction for true exactly-once.
 */
export interface ProcessedStore {
  /** True if `id` has already been applied. */
  has(id: string): Promise<boolean>;
  /** Record `id` as processed (auto-commit path). */
  markProcessed(id: string, topic: string): Promise<void>;
  /** Record `id` as processed within the handler's transaction (preferred). */
  markProcessedTx?(tx: Tx, id: string, topic: string): Promise<void>;
}

/** The effect to apply for a not-yet-seen message. */
export type InboxHandler = (msg: InboxMessage, tx?: Tx) => Promise<void>;

export interface IdempotentConsumerOptions {
  /**
   * Optional transaction binder. When provided, the dedup mark and the handler
   * run inside ONE transaction (atomic exactly-once). When absent, they run
   * sequentially (handler then mark) — at-least-once with idempotent apply.
   */
  runInTx?: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
}

export class IdempotentInboxConsumer {
  constructor(
    private readonly processed: ProcessedStore,
    private readonly opts: IdempotentConsumerOptions = {},
  ) {}

  /**
   * Process one message exactly once. Returns true if the handler ran, false if
   * the message was a duplicate and was skipped.
   */
  async handle(msg: InboxMessage, handler: InboxHandler): Promise<boolean> {
    // Fast-path dedup: cheap pre-check before doing any work.
    if (await this.processed.has(msg.id)) return false;

    const runInTx = this.opts.runInTx;
    if (runInTx && this.processed.markProcessedTx) {
      // Atomic exactly-once: re-check inside the tx, apply handler, then mark.
      // If a concurrent worker raced us, its PRIMARY-KEY insert collides and
      // this transaction rolls back — the effect still applies exactly once.
      return runInTx(async (tx) => {
        if (await this.processed.has(msg.id)) return false;
        await handler(msg, tx);
        await this.processed.markProcessedTx!(tx, msg.id, msg.topic);
        return true;
      });
    }

    // No tx binder: apply then mark. Safe for idempotent handlers; a crash
    // between the two simply re-delivers (handler must tolerate that).
    await handler(msg);
    await this.processed.markProcessed(msg.id, msg.topic);
    return true;
  }
}

/** In-memory {@link ProcessedStore} for tests. */
export class InMemoryProcessedStore implements ProcessedStore {
  private readonly seen = new Set<string>();

  async has(id: string): Promise<boolean> {
    return this.seen.has(id);
  }

  async markProcessed(id: string): Promise<void> {
    this.seen.add(id);
  }

  size(): number {
    return this.seen.size;
  }
}
