/**
 * PROJECT TITAN — Kafka topic naming (Deliverable 5/8, messaging)
 *
 * Single source of truth for topic names so producers, the relay, and consumers
 * never hand-roll (and drift on) string literals. Convention:
 *
 *     titan.<bounded-context>.<event-family>
 *
 * Topics are lower-case, dot-delimited, and stable: renaming a topic is a
 * breaking change for every consumer, so add new ones rather than mutate these.
 */

/** Namespace prefix for every Titan topic. */
export const TOPIC_NAMESPACE = 'titan' as const;

export const Topics = {
  /** Hash-chained ledger events for a transaction aggregate (the main stream). */
  LedgerTransaction: 'titan.ledger.transaction',
  /** Compliance decisions (allow/deny + reasons) emitted by the gates. */
  ComplianceDecision: 'titan.compliance.decision',
  /** Crypto execution / chain-delivery lifecycle events. */
  CryptoExecution: 'titan.crypto.execution',
  /** Treasury reconciliation cases opened on post-commit failure. */
  TreasuryReconciliation: 'titan.treasury.reconciliation',
} as const;

/** Union of every known topic name (handy for exhaustive routing/validation). */
export type TopicName = (typeof Topics)[keyof typeof Topics];

/** The default topic for ledger writes when a caller does not override one. */
export const DEFAULT_LEDGER_TOPIC: TopicName = Topics.LedgerTransaction;
