/**
 * PROJECT TITAN — Atomic ledger + outbox writer (Deliverable 5/8, CENTERPIECE)
 *
 * Implements {@link LedgerOutboxWriter}. This is the single primitive the saga
 * calls instead of poking the ledger store and the outbox store separately.
 *
 * In ONE database transaction it:
 *   1. reads the aggregate's current head hash (or GENESIS = 64 zeros),
 *   2. hashes the new event onto the chain (`hashEvent`),
 *   3. appends the ledger event, and
 *   4. inserts the matching outbox row carrying that exact event as its payload.
 *
 * Because steps 3 and 4 run on the SAME `Tx`, they commit or roll back together:
 * there is no state in which the ledger advanced but no event was enqueued, nor
 * one in which an event was enqueued for a ledger write that never happened. The
 * classic dual-write inconsistency (DB updated, broker missed, or vice-versa) is
 * structurally impossible here — publication to Kafka is deferred to the relay,
 * which reads only committed outbox rows.
 */
import type { UnitOfWork, Tx } from '../persistence/db';
import { type LedgerEvent, hashEvent } from '../ledger/ledger.service';
import type { LedgerOutboxWriter, OutboxStore } from './messaging.ports';

/**
 * Transaction-aware ledger persistence the writer depends on.
 *
 * NOTE: this mirrors `TxAwareLedgerStore` in
 * `../persistence/repository.contracts.ts`, which is owned by the persistence
 * agent and may not exist yet in this workspace. It is re-declared (structurally
 * identical) here so the messaging library compiles and is testable on its own;
 * once the persistence contract lands, its implementation satisfies this shape
 * by structural typing. Keep the two in lock-step.
 */
export interface TxAwareLedgerStore {
  /** Current head hash for an aggregate within `tx`, or null if none yet. */
  lastHashTx(tx: Tx, aggregateId: string): Promise<string | null>;
  /** Append a ledger event within `tx` (participates in the caller's commit). */
  appendTx(tx: Tx, event: LedgerEvent): Promise<void>;
}

/** GENESIS head for an aggregate with no prior events (64 hex zeros). */
const GENESIS = '0'.repeat(64);

export class LedgerOutboxWriterImpl implements LedgerOutboxWriter {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly ledgerStore: TxAwareLedgerStore,
    private readonly outboxStore: OutboxStore,
    private readonly now: () => string,
  ) {}

  /**
   * Append a chained ledger event and enqueue its outbox row atomically.
   * Returns the persisted {@link LedgerEvent}. If anything inside the unit of
   * work throws, the UoW rolls the whole transaction back — neither the ledger
   * row nor the outbox row survives.
   */
  async record(
    aggregateId: string,
    type: string,
    payload: Record<string, unknown>,
    topic: string,
  ): Promise<LedgerEvent> {
    return this.uow.run(async (tx) => {
      // Serialize concurrent appends for the SAME aggregate. Without this, two
      // record() calls under READ COMMITTED could both read the same head hash,
      // both chain from it, and fork the chain (two events sharing one prev_hash).
      // A transaction-scoped advisory lock keyed on the aggregate id makes the
      // read-then-write atomic per aggregate; it auto-releases at commit/rollback
      // and never blocks appends to a DIFFERENT aggregate. (The UNIQUE constraint
      // on ledger_events(aggregate_id, prev_hash) is the durable backstop.)
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [aggregateId]);

      const prev = (await this.ledgerStore.lastHashTx(tx, aggregateId)) ?? GENESIS;
      const hash = hashEvent(prev, type, payload);
      const event: LedgerEvent = {
        aggregateId,
        type,
        payload,
        prevHash: prev,
        hash,
        createdAt: this.now(),
      };

      await this.ledgerStore.appendTx(tx, event);
      await this.outboxStore.insertTx(tx, {
        aggregateId,
        type,
        topic,
        key: aggregateId,        // partition by aggregate => per-aggregate ordering
        payload: { ...event },   // the full chained event is the message body
        createdAt: this.now(),
      });

      return event;
    });
  }
}
