/**
 * PROJECT TITAN — Chain node / sender ports (Phase 6)
 *
 * Mirrors the payment-gateway HttpClient pattern: every sender takes an INJECTED
 * NodeClient (one per chain/provider). Nothing here connects at import time and
 * there is no real network — tests pass an in-memory fake (see testing/).
 *
 * The NodeClient is deliberately thin and chain-agnostic. The family-specific
 * senders know how to BUILD a transfer; the NodeClient only knows how to push
 * an opaque broadcast intent to a provider and read back status/fees.
 */

export type TxStatus = 'PENDING' | 'CONFIRMED' | 'DROPPED';

/** Result of pushing a transaction to the network. */
export interface BroadcastResult {
  txid: string;
}

/** Normalized on-chain status used by the confirmation poller. */
export interface TxStatusResult {
  confirmations: number;
  status: TxStatus;
  /** Effective fee rate observed (sat/vByte for BTC, gwei for EVM) if known. */
  feeRate?: string;
}

/** Suggested fee for building/repricing a transaction (decimal string units). */
export interface FeeSuggestion {
  /** sat/vByte (BTC) or maxFeePerGas in gwei (EVM), as a decimal STRING. */
  feeRate: string;
  /** Optional EVM priority tip in gwei (decimal string). */
  priorityFee?: string;
}

/**
 * A broadcast intent: the opaque, already-built+signed-or-buildable payload the
 * NodeClient pushes. Senders populate the family-relevant fields; the engine and
 * NodeClient treat it as opaque beyond `deliveryId` (for provider idempotency)
 * and `chain` (for routing). Amounts are ALWAYS integer base units as strings
 * carrying a BigInt value — never floats.
 */
export interface BroadcastIntent {
  /** Stable per-delivery id; lets a provider dedupe a replayed broadcast. */
  deliveryId: string;
  chain: string;
  family: 'EVM' | 'BTC' | 'TRON' | 'SOLANA';
  /** Destination address, already validated + (EVM) checksummed. */
  to: string;
  /** Amount in integer base units (satoshi/wei/lamport/sun) as a string. */
  amountBaseUnits: string;
  /** Fee parameters resolved at build time (decimal strings, no floats). */
  fee?: FeeSuggestion;
  /** EVM-only: numeric EIP-155 chain id, pinning the network. */
  evmChainId?: number;
  /** Free-form, family-specific extras (e.g. nonce, UTXO selection hints). */
  meta?: Record<string, unknown>;
}

/**
 * Injected per-chain node/provider client. Concrete impls wrap an RPC/HTTP
 * client; tests inject the in-memory fake. NO method connects at import.
 */
export interface NodeClient {
  /** Push a built transfer to the network; returns the broadcast txid. */
  broadcast(intent: BroadcastIntent): Promise<BroadcastResult>;
  /** Read normalized confirmation status for a previously broadcast txid. */
  getStatus(txid: string): Promise<TxStatusResult>;
  /** Suggest a current fee for building/repricing a transaction. */
  suggestFee(): Promise<FeeSuggestion>;
  /**
   * Re-price / re-broadcast a stuck transaction:
   *   - BTC: RBF (replace-by-fee) or CPFP,
   *   - EVM: same-nonce replacement at a higher gas price.
   * Returns the (possibly NEW) txid to continue polling.
   */
  bumpFee(txid: string): Promise<BroadcastResult>;
}

/** Outcome of an atomic delivery reservation (see `reserve`). */
export type ReserveOutcome =
  | { status: 'WON' }                       // caller owns the broadcast; proceed
  | { status: 'ALREADY_SENT'; txid: string } // a prior caller already broadcast
  | { status: 'LOST' };                      // a concurrent caller is broadcasting now

/**
 * Idempotency ledger for deliveries. Guarantees a retried `send` NEVER results
 * in a second broadcast / double-spend.
 *
 * The safe ordering is RESERVE -> broadcast -> record, NOT check -> broadcast ->
 * record: a plain `wasSent` read before an irreversible broadcast is a TOCTOU
 * race (two concurrent callers both read null and both broadcast). `reserve`
 * closes that window by ATOMICALLY claiming the deliveryId — only the WON caller
 * broadcasts; a LOST caller must not. Backed by INSERT ... ON CONFLICT DO NOTHING
 * (or a unique-key insert of a PENDING row) in production.
 */
export interface DeliveryIdempotencyStore {
  /**
   * Atomically claim `deliveryId` before any broadcast. Exactly one concurrent
   * caller gets 'WON' (and must broadcast then `record`); others get
   * 'ALREADY_SENT' (a txid already exists) or 'LOST' (another caller holds the
   * reservation but has not recorded a txid yet).
   */
  reserve(deliveryId: string): Promise<ReserveOutcome>;
  /**
   * Release a WON-but-not-broadcast reservation. Called ONLY when the broadcast
   * provably never went out (the sender threw before submitting), so a genuine
   * later retry can re-claim the id. A no-op if the id was already recorded.
   */
  release(deliveryId: string): Promise<void>;
  /** Returns the recorded txid for a delivery, or null if never sent. */
  wasSent(deliveryId: string): Promise<string | null>;
  /** Persist that `deliveryId` was broadcast as `txid` (write-once). */
  record(deliveryId: string, txid: string): Promise<void>;
}

/**
 * Family sender contract. The engine selects a sender by chain family and calls
 * `send` with the validated destination and integer base-unit amount.
 */
export interface ChainSender {
  readonly family: 'EVM' | 'BTC' | 'TRON' | 'SOLANA';
  send(args: SenderSendArgs): Promise<BroadcastResult>;
}

export interface SenderSendArgs {
  deliveryId: string;
  chain: string;
  to: string;
  /** Integer base units (BigInt) — the engine has already done float-free conv. */
  amountBaseUnits: bigint;
  evmChainId?: number;
}
