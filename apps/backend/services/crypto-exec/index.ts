/**
 * PROJECT TITAN — Crypto Execution Engine (Phase 5) public barrel.
 *
 * The saga wires `CryptoExecEngine` as its `CryptoExecPort`. Everything a
 * consumer needs (port types, adapters, router, engine, and the test double) is
 * re-exported here so nothing reaches into the package's internals.
 */

// Normalized port + shared types
export * from './exchange.port';

// Decimal/money helpers (no-float guarantees)
export * from './decimal';

// Venue adapters
export { KrakenAdapter } from './adapters/kraken.adapter';
export type { KrakenAuthSigner } from './adapters/kraken.adapter';
export { CoinbaseAdapter } from './adapters/coinbase.adapter';
export type { CoinbaseJwtMinter } from './adapters/coinbase.adapter';
export { BinanceAdapter } from './adapters/binance.adapter';
export type { BinanceSigner } from './adapters/binance.adapter';
export { OkxAdapter } from './adapters/okx.adapter';
export type { OkxSigner } from './adapters/okx.adapter';

// Smart order router
export {
  SmartOrderRouter, DEFAULT_SOR_CONFIG,
} from './smart-order-router';
export type {
  BestExecRequest, BestExecResult, BestExecSuccess, BestExecFailure,
  AttemptRecord, SmartOrderRouterConfig,
} from './smart-order-router';

// Engine (implements CryptoExecPort)
export {
  CryptoExecEngine, DEFAULT_CRYPTO_EXEC_CONFIG,
} from './crypto-exec.engine';
export type { CryptoExecConfig } from './crypto-exec.engine';

// Test double (kept in the barrel intentionally — used by integration specs)
export { InMemoryExchange } from './testing/in-memory-exchange';
export type { FakeVenueConfig, RecordedOrder } from './testing/in-memory-exchange';
