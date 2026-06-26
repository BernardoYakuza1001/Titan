/**
 * PROJECT TITAN — Transaction Saga Orchestrator (Phase 4/5/6)
 *
 * Drives a transaction through the state machine, calling each downstream
 * domain (auth, compliance, risk, crypto exec, chain delivery) and recording
 * every transition to the hash-chained ledger. On failure it runs the correct
 * COMPENSATION:
 *   - pre-commit failure   -> void/refund the fiat auth (REVERSED)
 *   - post-commit failure  -> mark FAILED + open a treasury reconciliation case
 *                             (crypto is irreversible; never silently lose funds)
 *
 * Every step is idempotent via the transaction's idempotency key + current
 * state guard, so retries and at-least-once event delivery are safe.
 */
import { Injectable, Logger } from '@nestjs/common';
import {
  TxState, TxEvent, next, isTerminal, requiresFiatUnwind, POST_COMMIT_STATES, canFire,
} from '../../libs/state-machine/transaction.state-machine';
import { LedgerService } from '../../libs/ledger/ledger.service';
import { ResolvedProfile } from '@titan/profile-schema';
import type { PriceQuote } from '../pricing/pricing.types';

export interface TransactionContext {
  id: string;
  deviceId: string;
  profile: ResolvedProfile;
  fiatAmount: number;
  fiatCurrency: string;
  asset: string;
  chain: string;
  destWallet: string;
  state: TxState;
  // identity/context for the blocking gates (populated at capture)
  customerId?: string;   // null => no verified customer on file
  cardToken?: string;    // network token (never raw PAN)
  geoCountry?: string;   // ISO-3166-1 alpha-2, from device/IP at capture
  /**
   * Filled base-asset qty (decimal string) from the crypto buy. Persisted on the
   * ctx the instant the buy fills so a CRASH after the buy but before/within
   * delivery can RESUME `send(ctx, cryptoQty)` — the qty is the irreversible
   * artifact that must survive a restart for re-entrant recovery.
   */
  cryptoQty?: string;
  /** Delivery txid, persisted once broadcast so a resumed run can poll it. */
  deliveryTxid?: string;
  /**
   * Priced split for this transaction (the revenue model). Computed at quote/
   * capture time. When present, the card is authorized for `fiatChargedMinor`
   * and the crypto buy spends `acquisitionBudgetMinor` (NOT the full charge), so
   * acquirer/taker/gas/FX are funded by the customer and the platform keeps the
   * markup. Absent => legacy behavior (charge == spend == fiatAmount). The quote
   * is fixed once persisted so a resumed run prices identically.
   */
  priceQuote?: PriceQuote;
}

/** Ports the saga depends on (hexagonal — concrete adapters injected in module). */
export interface AuthPort {
  authorize(ctx: TransactionContext): Promise<{ ok: boolean; authCode?: string; reason?: string }>;
  void(ctx: TransactionContext): Promise<void>;
}
export interface CompliancePort {
  check(ctx: TransactionContext): Promise<{ allow: boolean; reasons: string[] }>;
}
export interface RiskPort {
  evaluate(ctx: TransactionContext): Promise<{ allow: boolean; score: number; reasons: string[] }>;
}
export interface CryptoExecPort {
  buy(ctx: TransactionContext): Promise<{ ok: boolean; qty?: string; venue?: string; reason?: string }>;
}
/**
 * Pre-commit destination-address gate. A transaction must NEVER buy crypto for an
 * undeliverable address (bad checksum, wrong chain family, unknown chain). This
 * port is checked AFTER risk/compliance pass but BEFORE the irreversible crypto
 * buy, so a bad address compensates to REVERSED (void fiat) having placed ZERO
 * exchange orders. The concrete adapter wraps blockchain `validateDestination`.
 *
 * `valid:false` => reject; `reason` is a stable machine code for the ledger.
 */
export interface AddressValidationPort {
  validate(ctx: TransactionContext): { valid: boolean; reason?: string };
}

/**
 * Default gate used when no validator is injected: passes everything. The real
 * deployment injects an adapter over blockchain `validateDestination`; the
 * delivery engine still re-validates post-commit as defense-in-depth.
 */
export const ALLOW_ALL_ADDRESS_VALIDATION: AddressValidationPort = {
  validate: () => ({ valid: true }),
};
export interface ChainDeliveryPort {
  send(ctx: TransactionContext, qty: string): Promise<{ ok: boolean; txid?: string; reason?: string }>;
  awaitConfirmations(txid: string, chain: string): Promise<boolean>;
}
export interface CasePort {
  openTreasuryReconciliation(txnId: string, detail: Record<string, unknown>): Promise<void>;
}
export interface TxRepo {
  save(ctx: TransactionContext): Promise<void>;
}

@Injectable()
export class TransactionSaga {
  private readonly log = new Logger(TransactionSaga.name);

  constructor(
    private readonly ledger: LedgerService,
    private readonly auth: AuthPort,
    private readonly compliance: CompliancePort,
    private readonly risk: RiskPort,
    private readonly crypto: CryptoExecPort,
    private readonly delivery: ChainDeliveryPort,
    private readonly cases: CasePort,
    private readonly repo: TxRepo,
    /**
     * Pre-commit destination-address gate. Optional + last so existing wiring
     * (8-arg construction) keeps compiling; defaults to allow-all, with the
     * delivery engine's post-commit re-validation as defense-in-depth.
     */
    private readonly addressValidation: AddressValidationPort = ALLOW_ALL_ADDRESS_VALIDATION,
  ) {}

  /** Advance the state machine, persist, and record to ledger atomically. */
  private async transition(ctx: TransactionContext, event: TxEvent, payload: Record<string, unknown> = {}) {
    const to = next(ctx.state, event);
    ctx.state = to;
    await this.repo.save(ctx);
    await this.ledger.record(ctx.id, to, { event, ...payload });
    this.log.debug(`${ctx.id} -> ${to} (${event})`);
    return to;
  }

  /**
   * Run the full forward flow. Returns the terminal state. Designed to be
   * re-entrant: callable again on a partially-advanced ctx after a crash.
   */
  async run(ctx: TransactionContext): Promise<TxState> {
    try {
      if (ctx.state === 'CREATED') await this.transition(ctx, 'INPUT_CAPTURED');
      if (ctx.state === 'CAPTURED_INPUT') await this.transition(ctx, 'AUTH_REQUESTED');

      if (ctx.state === 'AUTHORIZING') {
        const a = await this.auth.authorize(ctx);
        if (!a.ok) return this.transition(ctx, 'AUTH_DECLINED', { reason: a.reason });
        await this.transition(ctx, 'AUTH_APPROVED', { authCode: a.authCode });
      }

      // ---- BLOCKING compliance gate (P2) ----
      if (ctx.state === 'AUTHORIZED') {
        const c = await this.compliance.check(ctx);
        if (!c.allow) return this.compensate(ctx, 'COMPLIANCE_FAIL', { reasons: c.reasons });
        await this.transition(ctx, 'COMPLIANCE_PASS', { reasons: c.reasons });
      }

      // ---- BLOCKING risk gate (P2) ----
      if (ctx.state === 'RISK_REVIEW') {
        const r = await this.risk.evaluate(ctx);
        if (!r.allow) return this.compensate(ctx, 'RISK_FAIL', { score: r.score, reasons: r.reasons });

        // ---- PRE-COMMIT DESTINATION-ADDRESS GATE ----
        // A transaction must NEVER buy crypto for an undeliverable address. This
        // runs while still in RISK_REVIEW (pre-commit, fiat reversible) and BEFORE
        // any exchange order is placed. An invalid / chain-mismatched address
        // reuses the RISK_FAIL -> REVERSED compensation path (voids the fiat hold)
        // having placed ZERO crypto orders. The delivery engine re-validates
        // post-commit as defense-in-depth.
        const addr = this.addressValidation.validate(ctx);
        if (!addr.valid) {
          return this.compensate(ctx, 'RISK_FAIL', { reasons: [`INVALID_DESTINATION:${addr.reason ?? 'UNKNOWN'}`] });
        }

        await this.transition(ctx, 'RISK_PASS', { score: r.score });
      }

      if (ctx.state === 'APPROVED') await this.transition(ctx, 'CRYPTO_QUEUED');

      // ---- crypto execution (still pre-commit: can REVERSE fiat on failure) ----
      if (ctx.state === 'CRYPTO_PENDING') {
        const buy = await this.crypto.buy(ctx);
        if (!buy.ok) return this.compensate(ctx, 'CRYPTO_EXEC_FAILED', { reason: buy.reason });
        // Persist the filled qty on the ctx BEFORE the state flips post-commit so a
        // crash here resumes delivery with the correct (irreversible) amount.
        ctx.cryptoQty = buy.qty;
        await this.transition(ctx, 'CRYPTO_FILLED', { venue: buy.venue, qty: buy.qty }); // -> CRYPTO_EXECUTING
      }

      // ---- POST-COMMIT: crypto bought; from here failures are NOT fiat-reversible ----
      // Each step has its OWN state-keyed guard (not nested under CRYPTO_PENDING) so a
      // ctx persisted mid-flight at CRYPTO_EXECUTING / DELIVERING / CONFIRMING RESUMES
      // forward after a crash. delivery.send + awaitConfirmations are idempotent.
      if (ctx.state === 'CRYPTO_EXECUTING') {
        const qty = this.recoverQty(ctx);
        if (qty === undefined) {
          // Cannot resume delivery without the qty -> open a case rather than guess.
          return this.failPostCommit(ctx, 'BROADCAST_FAILED', { reason: 'QTY_UNRECOVERABLE' });
        }
        const send = await this.delivery.send(ctx, qty);
        if (!send.ok) return this.failPostCommit(ctx, 'BROADCAST_FAILED', { reason: send.reason, qty });
        ctx.deliveryTxid = send.txid;
        await this.transition(ctx, 'BROADCAST_OK', { txid: send.txid }); // -> DELIVERING
      }

      if (ctx.state === 'DELIVERING') {
        const txid = ctx.deliveryTxid;
        if (!txid) return this.failPostCommit(ctx, 'BROADCAST_FAILED', { reason: 'TXID_UNRECOVERABLE' });
        const confirmed = await this.delivery.awaitConfirmations(txid, ctx.chain);
        if (!confirmed) return this.failPostCommit(ctx, 'BROADCAST_FAILED', { txid });
        await this.transition(ctx, 'CONFIRMED', { txid }); // -> CONFIRMING
      }

      if (ctx.state === 'CONFIRMING') {
        await this.transition(ctx, 'CONFIRMED', { txid: ctx.deliveryTxid }); // -> COMPLETED
      }

      // ---- BACKSTOP: never return silently stuck in a non-terminal post-commit state.
      // A clean fall-through that still sits past the commit line means funds may be
      // out without reconciliation — open a treasury case instead of leaking.
      if (!isTerminal(ctx.state) && POST_COMMIT_STATES.has(ctx.state)) {
        return this.failPostCommitLegal(ctx, { reason: 'STUCK_POST_COMMIT', state: ctx.state });
      }

      return ctx.state;
    } catch (err) {
      // Branch on the bright line: a pre-commit error VOIDS the fiat (REVERSED, no
      // treasury case); a post-commit error opens a treasury case + a LEGAL terminal.
      // Wrapped so a transition error inside the handler can never escape run().
      this.log.error(`${ctx.id} saga error: ${(err as Error).message}`);
      try {
        if (isTerminal(ctx.state)) return ctx.state;
        if (POST_COMMIT_STATES.has(ctx.state)) {
          return await this.failPostCommitLegal(ctx, { error: String(err) });
        }
        // Pre-commit failure (AUTHORIZED/COMPLIANCE_HOLD/RISK_REVIEW/APPROVED/
        // CRYPTO_PENDING, etc.): void the fiat auth and land REVERSED — NO case,
        // NO BROADCAST_FAILED (which would be an illegal transition here).
        return await this.compensate(ctx, this.preCommitFailEvent(ctx.state), { error: String(err) });
      } catch (inner) {
        // A failure inside compensation must not reject run() and strand the tx.
        this.log.error(`${ctx.id} compensation error: ${(inner as Error).message}`);
        return ctx.state;
      }
    }
  }

  /** Recover the filled qty for a resumed post-commit run (persisted on the ctx). */
  private recoverQty(ctx: TransactionContext): string | undefined {
    return ctx.cryptoQty;
  }

  /** The legal pre-commit failure event for `state` (all route to REVERSED/DECLINED). */
  private preCommitFailEvent(state: TxState): TxEvent {
    switch (state) {
      case 'AUTHORIZING':     return 'AUTH_DECLINED';   // -> DECLINED (no hold yet)
      case 'AUTHORIZED':
      case 'COMPLIANCE_HOLD': return 'COMPLIANCE_FAIL'; // -> REVERSED
      case 'RISK_REVIEW':     return 'RISK_FAIL';       // -> REVERSED
      case 'CRYPTO_PENDING':  return 'CRYPTO_EXEC_FAILED'; // -> REVERSED
      // APPROVED has no direct fail edge; queue then fail keeps it legal.
      default:                return 'CRYPTO_EXEC_FAILED';
    }
  }

  /**
   * Post-commit failure with a LEGAL terminal event for the current state. Opens a
   * treasury reconciliation case (crypto is irreversible) and lands FAILED via the
   * event the state machine actually allows from here.
   */
  private async failPostCommitLegal(ctx: TransactionContext, payload: Record<string, unknown>) {
    await this.cases.openTreasuryReconciliation(ctx.id, { stage: 'post_commit', ...payload });
    // CRYPTO_EXECUTING + BROADCAST_FAILED -> FAILED; DELIVERING + BROADCAST_FAILED -> FAILED.
    // CONFIRMING has no failure edge, so drive it forward to COMPLETED (the send
    // already succeeded; reconciliation tracks confirmation depth out-of-band).
    if (ctx.state === 'CONFIRMING') {
      return this.transition(ctx, 'CONFIRMED', { ...payload }); // -> COMPLETED
    }
    return this.transition(ctx, 'BROADCAST_FAILED', payload); // -> FAILED
  }

  /** Pre-commit compensation: void the fiat hold, land in REVERSED. */
  private async compensate(ctx: TransactionContext, event: TxEvent, payload: Record<string, unknown>) {
    if (requiresFiatUnwind(ctx.state)) {
      try { await this.auth.void(ctx); } catch (e) {
        await this.cases.openTreasuryReconciliation(ctx.id, { stage: 'void', error: String(e) });
      }
    }
    // APPROVED has no direct fail edge (only CRYPTO_QUEUED). If we're compensating
    // from there, advance the one legal forward step so the fail event is legal.
    if (ctx.state === 'APPROVED' && !canFire(ctx.state, event)) {
      await this.transition(ctx, 'CRYPTO_QUEUED'); // APPROVED -> CRYPTO_PENDING
    }
    return this.transition(ctx, event, payload); // -> REVERSED (or DECLINED)
  }

  /** Post-commit: crypto already irreversible. Mark FAILED + treasury case. */
  private async failPostCommit(ctx: TransactionContext, event: TxEvent, payload: Record<string, unknown>) {
    await this.cases.openTreasuryReconciliation(ctx.id, { stage: 'post_commit', ...payload });
    return this.transition(ctx, event, payload); // -> FAILED
  }
}
