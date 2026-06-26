/**
 * PROJECT TITAN — Broker producer adapters (Deliverable 5/8)
 *
 * Implements {@link MessageProducer}: the one normalized `publish(topic, key,
 * value)` call the relay uses, hiding kafkajs's client quirks.
 *
 * IMPORTANT DESIGN NOTES
 *  - The kafkajs CLIENT is INJECTED, never imported at module load. We depend on
 *    a minimal structural interface ({@link KafkaProducerClient}) that kafkajs's
 *    real `Producer` satisfies, so this file compiles and the messaging barrel is
 *    importable even where `kafkajs` is not installed (e.g. unit tests on
 *    pg-mem). Wiring code constructs the real client:
 *
 *        import { Kafka } from 'kafkajs';
 *        const kafka = new Kafka({ clientId: 'titan', brokers: [...] });
 *        const producer = kafka.producer({ idempotent: true });
 *        await producer.connect();
 *        const adapter = new KafkaMessageProducer(producer);
 *
 *  - We do NOT connect at import time. `connect()`/`disconnect()` are explicit
 *    lifecycle calls owned by the composition root.
 *  - Enable kafkajs idempotent producer (`idempotent: true`, acks=all) so broker
 *    retries do not duplicate at the partition level. Combined with the outbox
 *    relay's at-least-once drain and the inbox consumer's dedup, the end-to-end
 *    effect is exactly-once.
 */
import type { MessageProducer } from './messaging.ports';

/**
 * Structural subset of kafkajs's `Producer` we rely on. kafkajs's real producer
 * is assignable to this, but we avoid a hard compile-time dependency on the
 * package (which may be absent in test/CI installs).
 */
export interface KafkaProducerClient {
  send(record: {
    topic: string;
    messages: Array<{ key?: string | Buffer | null; value: string | Buffer | null }>;
    acks?: number;
  }): Promise<unknown>;
  connect?(): Promise<void>;
  disconnect?(): Promise<void>;
}

export interface KafkaMessageProducerOptions {
  /**
   * Require all in-sync replicas to ack each write (acks=-1). Default true: this
   * is non-negotiable for a money ledger — never lose an acknowledged event.
   */
  acksAll?: boolean;
}

export class KafkaMessageProducer implements MessageProducer {
  private readonly acks: number;

  constructor(
    private readonly producer: KafkaProducerClient,
    opts: KafkaMessageProducerOptions = {},
  ) {
    this.acks = (opts.acksAll ?? true) ? -1 : 1;
  }

  /** Optional explicit connect (composition root calls this once at startup). */
  async connect(): Promise<void> {
    if (this.producer.connect) await this.producer.connect();
  }

  /** Optional graceful shutdown. */
  async disconnect(): Promise<void> {
    if (this.producer.disconnect) await this.producer.disconnect();
  }

  /**
   * Publish one message. `key` drives partitioning, which is what preserves
   * per-aggregate ordering (same aggregateId => same partition => FIFO). The
   * value is JSON-serialized; the broker stores opaque bytes.
   */
  async publish(topic: string, key: string, value: Record<string, unknown>): Promise<void> {
    await this.producer.send({
      topic,
      acks: this.acks,
      messages: [{ key, value: JSON.stringify(value) }],
    });
  }
}

/**
 * In-memory producer for tests: records every published message instead of
 * touching a broker. Lets specs assert on what the relay would have emitted, and
 * `failNextN` simulates broker failures to exercise the markFailed/retry path.
 */
export class InMemoryMessageProducer implements MessageProducer {
  readonly published: Array<{ topic: string; key: string; value: Record<string, unknown> }> = [];
  private failures = 0;

  /** Make the next `n` publish calls reject (to test retry/markFailed). */
  failNext(n = 1): void {
    this.failures += n;
  }

  async publish(topic: string, key: string, value: Record<string, unknown>): Promise<void> {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error(`InMemoryMessageProducer: simulated publish failure for ${topic}`);
    }
    this.published.push({ topic, key, value });
  }

  /** All messages seen for a topic, in publish order (test convenience). */
  forTopic(topic: string): Array<{ key: string; value: Record<string, unknown> }> {
    return this.published.filter((m) => m.topic === topic).map(({ key, value }) => ({ key, value }));
  }

  clear(): void {
    this.published.length = 0;
    this.failures = 0;
  }
}
