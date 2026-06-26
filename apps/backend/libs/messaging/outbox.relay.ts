/**
 * PROJECT TITAN — Outbox relay (Deliverable 5/8)
 *
 * Implements {@link OutboxRelay}. Bridges the committed outbox table to Kafka:
 * `drainOnce()` fetches one FIFO batch of pending rows, publishes each via the
 * {@link MessageProducer}, and flips it published (success) or failed (error).
 *
 * GUARANTEES
 *  - At-least-once: a row is only marked published AFTER `publish` resolves. If
 *    the relay crashes between publish and markPublished, the row stays pending
 *    and is re-sent next drain — never lost.
 *  - Idempotent / safe to repeat: `markPublished` flips `published_at`, and
 *    `fetchUnpublished` filters on `published_at IS NULL`, so a published row is
 *    never re-fetched. Re-running drainOnce on an empty backlog returns 0.
 *  - Per-aggregate ordering: rows are fetched `ORDER BY seq` (the monotonic
 *    bigserial = true insertion order) and published in that order; identical
 *    keys (= aggregateId) land on one Kafka partition, so consumers see events in
 *    produced order. To keep ordering strict under a mid-batch failure we STOP
 *    the batch at the first failing row rather than skipping ahead past it (a
 *    later event for the same aggregate must not overtake an earlier un-published
 *    one).
 *
 * Duplicates are still possible (publish succeeded, markPublished didn't) — that
 * is the price of at-least-once. Consumers dedup via the inbox helper, making the
 * end-to-end EFFECT exactly-once.
 */
import type {
  MessageProducer,
  OutboxRelay,
  OutboxRecord,
  OutboxStore,
} from './messaging.ports';

export interface OutboxRelayOptions {
  /** Max rows to drain per `drainOnce` call. Default 100. */
  batchSize?: number;
  /**
   * If true (default), stop the batch at the first publish failure so a later
   * event for the same aggregate cannot be published ahead of an earlier failed
   * one. If false, keep going (higher throughput, but only safe when strict
   * per-aggregate ordering across the batch is not required).
   */
  stopOnError?: boolean;
}

export class OutboxRelayImpl implements OutboxRelay {
  private readonly batchSize: number;
  private readonly stopOnError: boolean;

  constructor(
    private readonly store: OutboxStore,
    private readonly producer: MessageProducer,
    opts: OutboxRelayOptions = {},
  ) {
    this.batchSize = opts.batchSize ?? 100;
    this.stopOnError = opts.stopOnError ?? true;
  }

  /**
   * Publish one batch of pending rows. Returns the number actually published.
   * Successes and failures are flushed to the store in bulk at the end.
   */
  async drainOnce(): Promise<number> {
    const batch = await this.store.fetchUnpublished(this.batchSize);
    if (batch.length === 0) return 0;

    const publishedIds: string[] = [];
    const failedIds: string[] = [];

    for (const rec of batch) {
      try {
        await this.producer.publish(rec.topic, rec.key, rec.payload);
        if (rec.id) publishedIds.push(rec.id);
      } catch {
        if (rec.id) failedIds.push(rec.id);
        if (this.stopOnError) {
          // Preserve per-aggregate ordering: do not race later events ahead of
          // this failed one. Remaining rows stay pending for the next drain.
          break;
        }
      }
    }

    // Mark successes first so a crash during markFailed can never un-publish a
    // row that already made it to the broker.
    if (publishedIds.length > 0) await this.store.markPublished(publishedIds);
    if (failedIds.length > 0) await this.store.markFailed(failedIds);

    return publishedIds.length;
  }

  /**
   * Convenience loop: drain repeatedly until the backlog is empty (or a drain
   * makes no progress). Returns the total published. Intended for tests and
   * one-shot catch-up; production runs `drainOnce` on a timer.
   */
  async drainAll(maxIterations = 1000): Promise<number> {
    let total = 0;
    for (let i = 0; i < maxIterations; i++) {
      const n = await this.drainOnce();
      total += n;
      if (n === 0) break;
    }
    return total;
  }
}

/** Re-export for callers that want the row type alongside the relay. */
export type { OutboxRecord };
