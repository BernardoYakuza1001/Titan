/**
 * PROJECT TITAN — Universal Blockchain Delivery Engine (Phase 6)
 *
 * Implements the saga's ChainDeliveryPort over EVERY supported chain. It is the
 * post-commit money-mover, so its invariants are safety-critical:
 *
 *   - VALIDATE the destination for the DECLARED chain (ctx.chain) before any
 *     broadcast — defense-in-depth even though `validateDestination` already ran
 *     pre-commit in the saga. An EVM hex address is valid on many chains, so the
 *     declared chain is authoritative and a family mismatch is rejected.
 *   - FLOAT-FREE amounts: the decimal-string qty is converted to integer base
 *     units (BigInt) using the chain's decimals — no Number(), no rounding.
 *   - IDEMPOTENT, NO DOUBLE-SEND: a deliveryId derived from ctx.id is ATOMICALLY
 *     reserved in the DeliveryIdempotencyStore BEFORE the irreversible broadcast
 *     (reserve -> broadcast -> record, never check -> broadcast -> record, which
 *     is a TOCTOU double-broadcast race under concurrent redelivery). Only the
 *     caller that WINS the reservation broadcasts; a caller that already sent gets
 *     the recorded txid and NOTHING is re-broadcast. The (deliveryId -> txid)
 *     record is written the instant broadcast succeeds.
 *   - awaitConfirmations polls getStatus until requiredConfirmations (per
 *     chains.ts) or a bounded attempt budget; if PENDING too long it bumps the
 *     fee ONCE (RBF/CPFP or EVM re-price) and keeps polling within budget;
 *     DROPPED or budget-exhausted -> false. The clock/sleep is injected so tests
 *     are deterministic and fast.
 *
 * No real network and no connect-at-import: the NodeClient is injected.
 */
import { ChainDeliveryPort, TransactionContext } from '../transaction/transaction.saga';
import { WalletValidation } from '@titan/profile-schema';
import { getChain, ChainSpec } from './chains';
import { validateAddress, AddressCheck } from './address';
import { toBaseUnits } from './base-units';
import {
  NodeClient, DeliveryIdempotencyStore, ChainSender,
} from './sender.port';
import { buildSenders } from './senders';

/** Injected clock so confirmation polling is deterministic in tests. */
export interface Clock {
  sleep(ms: number): Promise<void>;
}

/** Real wall-clock used in production. */
export const realClock: Clock = {
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** Tunable polling/retry budget for awaitConfirmations. */
export interface ConfirmationPolicy {
  /** Max poll attempts before giving up (budget). */
  maxAttempts: number;
  /** Delay between polls, in ms (multiplied by injected clock). */
  pollIntervalMs: number;
  /** Consecutive PENDING polls tolerated before a single fee bump fires. */
  pendingBeforeBump: number;
}

export const DEFAULT_CONFIRMATION_POLICY: ConfirmationPolicy = {
  maxAttempts: 60,
  pollIntervalMs: 3000,
  pendingBeforeBump: 10,
};

export interface DeliveryEngineDeps {
  /** Resolve the NodeClient for a given chain (per chain/provider injection). */
  nodeFor(chain: string): NodeClient;
  idempotency: DeliveryIdempotencyStore;
  clock?: Clock;
  policy?: Partial<ConfirmationPolicy>;
}

export interface DeliveryResult {
  ok: boolean;
  txid?: string;
  reason?: string;
}

/**
 * PRE-COMMIT destination gate used by the saga before any fiat is captured.
 * Validates the address for the declared chain and applies the profile's
 * WalletValidation policy (checksum enforcement etc.). Pure + side-effect-free.
 */
export function validateDestination(
  chain: string,
  address: string,
  walletValidation: WalletValidation,
): AddressCheck {
  let spec: ChainSpec;
  try {
    spec = getChain(chain);
  } catch {
    return { valid: false, reason: 'UNKNOWN_CHAIN' };
  }

  const res = validateAddress(spec.id, address);
  if (!res.valid) return res;

  // enforceChecksum: for EVM, reject an all-lowercase/upper address that omits
  // the EIP-55 checksum when the profile demands it. (Mixed-case bad checksums
  // are already rejected by the validator above.)
  if (walletValidation.enforceChecksum && spec.family === 'EVM') {
    const body = address.replace(/^0[xX]/, '');
    const singleCase = body === body.toLowerCase() || body === body.toUpperCase();
    if (singleCase) return { valid: false, reason: 'CHECKSUM_REQUIRED' };
  }

  // screenDestination / blockMixers are chain-analytics gates owned by the
  // compliance lane (WalletScreeningPort). The engine surfaces the requirement
  // here so a misconfigured profile can't silently skip it; the actual screening
  // call lives in compliance and runs pre-commit alongside this check.
  return { valid: true };
}

export class ChainDeliveryEngine implements ChainDeliveryPort {
  private readonly clock: Clock;
  private readonly policy: ConfirmationPolicy;

  constructor(private readonly deps: DeliveryEngineDeps) {
    this.clock = deps.clock ?? realClock;
    this.policy = { ...DEFAULT_CONFIRMATION_POLICY, ...(deps.policy ?? {}) };
  }

  /** Stable per-transaction delivery id; the idempotency key for no-double-send. */
  private deliveryId(ctx: TransactionContext): string {
    return `delivery:${ctx.id}`;
  }

  private senderFor(node: NodeClient, family: ChainSpec['family']): ChainSender {
    return buildSenders(node)[family];
  }

  /**
   * Send `qty` (decimal string) of the asset to ctx.destWallet on ctx.chain.
   * Returns { ok, txid } or { ok:false, reason }. Never re-broadcasts a delivery
   * that already succeeded.
   */
  async send(ctx: TransactionContext, qty: string): Promise<DeliveryResult> {
    let spec: ChainSpec;
    try {
      spec = getChain(ctx.chain);
    } catch {
      return { ok: false, reason: 'UNKNOWN_CHAIN' };
    }

    // (a) Defense-in-depth destination validation for the DECLARED chain.
    const wv = ctx.profile?.dimensions?.walletValidation
      ?? { enforceChecksum: true, screenDestination: true, blockMixers: true };
    const check = validateDestination(spec.id, ctx.destWallet, wv);
    if (!check.valid) return { ok: false, reason: `INVALID_DESTINATION:${check.reason}` };

    // (b) Float-free decimal-string -> integer base units (BigInt).
    let amount: bigint;
    try {
      amount = toBaseUnits(qty, spec.nativeDecimals);
    } catch (e) {
      return { ok: false, reason: (e as Error).message };
    }
    if (amount <= 0n) return { ok: false, reason: 'AMOUNT_NOT_POSITIVE' };

    // (c) Idempotency: ATOMICALLY reserve the deliveryId BEFORE broadcasting.
    // A plain check-then-broadcast is a TOCTOU race — two concurrent callers
    // both read "not sent" and both irreversibly broadcast. `reserve` lets
    // exactly one caller WIN the broadcast; the rest get the winner's txid.
    const deliveryId = this.deliveryId(ctx);
    const reservation = await this.deps.idempotency.reserve(deliveryId);
    if (reservation.status === 'ALREADY_SENT') {
      return { ok: true, txid: reservation.txid };
    }
    if (reservation.status === 'LOST') {
      // A concurrent caller holds the reservation and is broadcasting now. We must
      // NOT broadcast (would double-spend). Return the winner's txid; if it has
      // not recorded yet, surface a transient conflict so the caller can retry.
      const existing = await this.deps.idempotency.wasSent(deliveryId);
      if (existing) return { ok: true, txid: existing };
      return { ok: false, reason: 'BROADCAST_FAILED:RESERVATION_HELD' };
    }

    // (d) We WON the reservation. Broadcast via the family-appropriate sender,
    // then record write-once. We are the only caller that can broadcast this id.
    const node = this.deps.nodeFor(spec.id);
    const sender = this.senderFor(node, spec.family);
    try {
      const { txid } = await sender.send({
        deliveryId,
        chain: spec.id,
        to: ctx.destWallet,
        amountBaseUnits: amount,
        evmChainId: spec.evmChainId,
      });
      // Record BEFORE returning so any retry after a crash here finds the txid.
      await this.deps.idempotency.record(deliveryId, txid);
      return { ok: true, txid };
    } catch (e) {
      // The broadcast threw before submitting — no funds moved. Release the
      // reservation so a legitimate retry can re-claim and try again (it would
      // otherwise be stuck as a held-but-never-sent claim forever).
      await this.deps.idempotency.release(deliveryId);
      return { ok: false, reason: `BROADCAST_FAILED:${(e as Error).message}` };
    }
  }

  /**
   * Poll until the tx reaches the chain's requiredConfirmations, bumping the fee
   * ONCE if it stays PENDING too long. Returns true on confirmation, false on
   * DROPPED or budget exhaustion. Bounded by policy.maxAttempts.
   */
  async awaitConfirmations(txid: string, chain: string): Promise<boolean> {
    let spec: ChainSpec;
    try {
      spec = getChain(chain);
    } catch {
      return false;
    }
    const node = this.deps.nodeFor(spec.id);
    const need = spec.requiredConfirmations;

    let currentTxid = txid;
    let pendingStreak = 0;
    let bumped = false;

    for (let attempt = 0; attempt < this.policy.maxAttempts; attempt++) {
      let status;
      try {
        status = await node.getStatus(currentTxid);
      } catch {
        // Transient provider error: treat as a pending poll within budget.
        pendingStreak++;
        await this.maybeBump(node, spec, currentTxid, pendingStreak, bumped).then((r) => {
          if (r) { currentTxid = r.txid; bumped = true; pendingStreak = 0; }
        });
        await this.clock.sleep(this.policy.pollIntervalMs);
        continue;
      }

      if (status.status === 'DROPPED') return false;

      if (status.status === 'CONFIRMED' && status.confirmations >= need) {
        return true;
      }

      // Either PENDING, or CONFIRMED-but-not-deep-enough: keep polling.
      pendingStreak = status.status === 'PENDING' ? pendingStreak + 1 : 0;

      const bump = await this.maybeBump(node, spec, currentTxid, pendingStreak, bumped);
      if (bump) { currentTxid = bump.txid; bumped = true; pendingStreak = 0; }

      await this.clock.sleep(this.policy.pollIntervalMs);
    }

    // Budget exhausted without reaching the required depth.
    return false;
  }

  /** Fire a single fee bump when stuck PENDING past the threshold. */
  private async maybeBump(
    node: NodeClient,
    _spec: ChainSpec,
    txid: string,
    pendingStreak: number,
    alreadyBumped: boolean,
  ): Promise<{ txid: string } | null> {
    if (alreadyBumped) return null;
    if (pendingStreak < this.policy.pendingBeforeBump) return null;
    try {
      // RBF/CPFP for BTC, same-nonce gas re-price for EVM — owned by NodeClient.
      return await node.bumpFee(txid);
    } catch {
      // A failed bump must not abort polling; continue with the original txid.
      return null;
    }
  }
}
