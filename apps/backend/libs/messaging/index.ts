/**
 * PROJECT TITAN — Messaging library barrel (Deliverable 5/8)
 *
 * Public surface of the transactional-outbox -> Kafka subsystem. Importing this
 * barrel must NOT connect to any broker or DB (no side effects at import time);
 * the kafkajs client is injected into the producer by the composition root.
 */

// Shared contracts (interfaces / types).
export type {
  OutboxRecord,
  OutboxStore,
  MessageProducer,
  OutboxRelay,
  LedgerOutboxWriter,
} from './messaging.ports';

// Topic naming.
export {
  Topics,
  TOPIC_NAMESPACE,
  DEFAULT_LEDGER_TOPIC,
  type TopicName,
} from './topics';

// Outbox persistence adapter.
export {
  PgOutboxStore,
  type PgOutboxStoreOptions,
  type OutboxQueryable,
} from './outbox.store';

// Atomic ledger + outbox writer (centerpiece).
export {
  LedgerOutboxWriterImpl,
  type TxAwareLedgerStore,
} from './ledger-outbox.writer';

// Broker producer adapters.
export {
  KafkaMessageProducer,
  InMemoryMessageProducer,
  type KafkaProducerClient,
  type KafkaMessageProducerOptions,
} from './kafka.producer';

// Relay (drains outbox -> broker).
export {
  OutboxRelayImpl,
  type OutboxRelayOptions,
} from './outbox.relay';

// Idempotent inbox consumer.
export {
  IdempotentInboxConsumer,
  InMemoryProcessedStore,
  type InboxMessage,
  type InboxHandler,
  type ProcessedStore,
  type IdempotentConsumerOptions,
} from './inbox.consumer';

// Postgres-backed inbox dedup store (backs migrations/003_inbox.sql).
export { PgProcessedStore } from './pg-processed.store';
