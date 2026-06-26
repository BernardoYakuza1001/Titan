/**
 * PROJECT TITAN — In-memory NodeClient + idempotency store (Phase 6, test infra)
 *
 * Mirrors the payment-gateway test-fake pattern: a fully deterministic, no-
 * network NodeClient whose behavior is SCRIPTED. Use it to drive the engine
 * through confirmation curves, drops, fee bumps, and broadcast failures without
 * any real chain.
 *
 * Configure via InMemoryNodeConfig:
 *   - confirmationsOverCalls : status.confirmations returned on the Nth getStatus
 *     call (e.g. [0,0,1,3] ramps to 3). The last value is held for later calls.
 *   - confirmedAt            : confirmations >= this flips status to CONFIRMED.
 *   - dropAfterCalls         : force DROPPED once getStatus has been called N×.
 *   - failBroadcast          : make broadcast() throw (simulates a rejected tx).
 *   - bumpYieldsNewTxid      : bumpFee() returns a fresh txid (RBF/EVM re-price).
 */
import {
  NodeClient, DeliveryIdempotencyStore, BroadcastIntent, BroadcastResult,
  TxStatusResult, FeeSuggestion, ReserveOutcome,
} from '../sender.port';

export interface InMemoryNodeConfig {
  /** confirmations[i] returned on the (i+1)-th getStatus call; last value held. */
  confirmationsOverCalls?: number[];
  /** Confirmations at/above which status becomes CONFIRMED (default 1). */
  confirmedAt?: number;
  /** After this many getStatus calls, force DROPPED (1-based; 0 = never). */
  dropAfterCalls?: number;
  /** When set, broadcast() throws this message. */
  failBroadcast?: string;
  /** When true, bumpFee returns a new txid; else returns the same txid. */
  bumpYieldsNewTxid?: boolean;
  /** Fee suggestion returned by suggestFee()/used in intents. */
  fee?: FeeSuggestion;
  /** Fixed txid for the first broadcast (default derived from deliveryId). */
  txid?: string;
}

export class InMemoryNode implements NodeClient {
  /** Every broadcast intent pushed — assert on these in tests. */
  public readonly broadcasts: BroadcastIntent[] = [];
  /** Count of getStatus calls (across any txid). */
  public statusCalls = 0;
  /** Count of bumpFee calls. */
  public bumpCalls = 0;

  private cfg: Required<Omit<InMemoryNodeConfig, 'failBroadcast' | 'txid'>> &
    Pick<InMemoryNodeConfig, 'failBroadcast' | 'txid'>;

  constructor(cfg: InMemoryNodeConfig = {}) {
    this.cfg = {
      confirmationsOverCalls: cfg.confirmationsOverCalls ?? [1],
      confirmedAt: cfg.confirmedAt ?? 1,
      dropAfterCalls: cfg.dropAfterCalls ?? 0,
      bumpYieldsNewTxid: cfg.bumpYieldsNewTxid ?? false,
      fee: cfg.fee ?? { feeRate: '10' },
      failBroadcast: cfg.failBroadcast,
      txid: cfg.txid,
    };
  }

  async broadcast(intent: BroadcastIntent): Promise<BroadcastResult> {
    if (this.cfg.failBroadcast) throw new Error(this.cfg.failBroadcast);
    this.broadcasts.push(intent);
    const txid = this.cfg.txid ?? `tx-${intent.deliveryId}`;
    return { txid };
  }

  async getStatus(_txid: string): Promise<TxStatusResult> {
    this.statusCalls++;
    if (this.cfg.dropAfterCalls > 0 && this.statusCalls >= this.cfg.dropAfterCalls) {
      return { confirmations: 0, status: 'DROPPED' };
    }
    const series = this.cfg.confirmationsOverCalls;
    const idx = Math.min(this.statusCalls - 1, series.length - 1);
    const confirmations = series[idx];
    const status = confirmations >= this.cfg.confirmedAt ? 'CONFIRMED' : 'PENDING';
    return { confirmations, status, feeRate: this.cfg.fee.feeRate };
  }

  async suggestFee(): Promise<FeeSuggestion> {
    return this.cfg.fee;
  }

  async bumpFee(txid: string): Promise<BroadcastResult> {
    this.bumpCalls++;
    return { txid: this.cfg.bumpYieldsNewTxid ? `${txid}-bumped` : txid };
  }
}

/**
 * In-memory, write-once idempotency store for delivery dedupe.
 *
 * `reserve` models an atomic INSERT ... ON CONFLICT DO NOTHING: the PENDING claim
 * is staked SYNCHRONOUSLY (before any await) so two concurrent callers — even
 * interleaved on the event loop — cannot both win. This is what makes the engine
 * safe against TOCTOU double-broadcast under at-least-once redelivery.
 */
export class InMemoryIdempotencyStore implements DeliveryIdempotencyStore {
  public readonly map = new Map<string, string>();
  /** deliveryIds that have been reserved (claimed) but not yet recorded. */
  private readonly reserved = new Set<string>();

  reserve(deliveryId: string): Promise<ReserveOutcome> {
    // Recorded already -> a txid exists; the caller short-circuits to it.
    const existingTxid = this.map.get(deliveryId);
    if (existingTxid !== undefined) {
      return Promise.resolve({ status: 'ALREADY_SENT', txid: existingTxid });
    }
    // Another caller holds the claim but hasn't recorded a txid yet -> LOST.
    if (this.reserved.has(deliveryId)) {
      return Promise.resolve({ status: 'LOST' });
    }
    // Stake the claim synchronously (atomic w.r.t. the single-threaded loop).
    this.reserved.add(deliveryId);
    return Promise.resolve({ status: 'WON' });
  }

  async release(deliveryId: string): Promise<void> {
    // Only drop a still-PENDING claim; never undo a recorded delivery.
    if (!this.map.has(deliveryId)) this.reserved.delete(deliveryId);
  }

  async wasSent(deliveryId: string): Promise<string | null> {
    return this.map.get(deliveryId) ?? null;
  }

  async record(deliveryId: string, txid: string): Promise<void> {
    // Write-once: a second record for the same delivery is a programming error.
    if (this.map.has(deliveryId) && this.map.get(deliveryId) !== txid) {
      throw new Error(`IDEMPOTENCY_CONFLICT:${deliveryId}`);
    }
    this.map.set(deliveryId, txid);
    this.reserved.delete(deliveryId);
  }
}

/** A clock whose sleep() resolves immediately — makes confirmation polls instant. */
export const instantClock = {
  sleep: async (_ms: number): Promise<void> => { /* no-op: deterministic + fast */ },
};
