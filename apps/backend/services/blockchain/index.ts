/**
 * PROJECT TITAN — Universal Blockchain Delivery Engine barrel (Phase 6)
 *
 * Public surface for the saga + wiring layer. The saga depends on
 * ChainDeliveryEngine (implements ChainDeliveryPort) and validateDestination
 * (pre-commit gate); everything else is exported for adapters/tests.
 */
export * from './chains';
export * from './base-units';
export * from './address';
export * from './sender.port';
export * from './senders';
export * from './delivery.engine';

// Test infrastructure is exported from a subpath to keep it out of prod imports
// by convention; re-export here for convenience in integration tests.
export {
  InMemoryNode, InMemoryIdempotencyStore, instantClock,
} from './testing/in-memory-node';
export type { InMemoryNodeConfig } from './testing/in-memory-node';
