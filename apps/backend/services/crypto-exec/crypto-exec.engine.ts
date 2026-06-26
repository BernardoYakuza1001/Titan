/**
 * PROJECT TITAN — Crypto Execution Engine (Phase 5)
 *
 * Implements the saga's `CryptoExecPort`. Given a TransactionContext it:
 *
 *   1. derives a DETERMINISTIC clientOrderId from ctx.id, so a retried buy
 *      (saga re-entry after a crash, at-least-once delivery) reuses the same id
 *      and the venue returns the original fill — never a second purchase;
 *   2. runs the SmartOrderRouter for best execution across healthy venues;
 *   3. enforces SLIPPAGE PROTECTION — if the executed vwap deviates beyond
 *      maxSlippageBps versus the router's reference quote, it ABORTS with a
 *      failure (the saga then reverses the fiat hold; this is still pre-commit,
 *      so failing here is safe — no crypto is delivered);
 *   4. returns { ok:true, qty, venue } on success, or { ok:false, reason } on a
 *      slippage breach / all-venues-down / reject.
 *
 * `maxSlippageBps` and the split threshold are configurable. This module NEVER
 * throws to the saga: every failure path returns a structured `{ ok:false }`.
 */
import { TransactionContext, CryptoExecPort } from '../transaction/transaction.saga';
import {
  SmartOrderRouter, SmartOrderRouterConfig, DEFAULT_SOR_CONFIG,
} from './smart-order-router';
import { ExchangeAdapter } from './exchange.port';
import { parseDecimal, slippageBps, netPrice, BPS_DENOM } from './decimal';
import { minorToMajor } from '../pricing/pricing.engine';

export interface CryptoExecConfig {
  /** Max tolerated adverse deviation of executed vwap vs reference quote (bps). */
  maxSlippageBps: number;
  /** Notional (fiat major units) at/above which the router splits child orders. */
  splitThresholdFiat: number;
  /** Number of child slices when splitting. */
  childSlices: number;
}

export const DEFAULT_CRYPTO_EXEC_CONFIG: CryptoExecConfig = {
  maxSlippageBps: 50,                          // 0.50% default guardrail
  splitThresholdFiat: DEFAULT_SOR_CONFIG.splitThresholdFiat,
  childSlices: DEFAULT_SOR_CONFIG.childSlices,
};

export class CryptoExecEngine implements CryptoExecPort {
  private readonly router: SmartOrderRouter;
  private readonly cfg: CryptoExecConfig;

  constructor(
    venues: ExchangeAdapter[],
    config: Partial<CryptoExecConfig> = {},
  ) {
    this.cfg = { ...DEFAULT_CRYPTO_EXEC_CONFIG, ...config };
    const sorConfig: SmartOrderRouterConfig = {
      splitThresholdFiat: this.cfg.splitThresholdFiat,
      childSlices: this.cfg.childSlices,
    };
    this.router = new SmartOrderRouter(venues, sorConfig);
  }

  /** Deterministic, idempotent order id for a transaction. Same ctx.id => same id. */
  static clientOrderId(ctx: TransactionContext): string {
    return `titan:${ctx.id}`;
  }

  async buy(ctx: TransactionContext): Promise<{ ok: boolean; qty?: string; venue?: string; reason?: string }> {
    const clientOrderId = CryptoExecEngine.clientOrderId(ctx);

    // SPEND the acquisition budget when the txn is priced (revenue model) — NOT the
    // full charge. The budget already excludes acquirer/taker/gas/FX + markup, so
    // the venue spend is what the customer's crypto is bought with. Unpriced txns
    // fall back to the headline fiatAmount (legacy behavior, charge == spend).
    const spendMajor = ctx.priceQuote
      ? Number(minorToMajor(ctx.priceQuote.acquisitionBudgetMinor, ctx.priceQuote.exponent))
      : ctx.fiatAmount;

    const result = await this.router.bestExecution({
      clientOrderId,
      asset: ctx.asset,
      fiatAmount: spendMajor,
      fiatCurrency: ctx.fiatCurrency,
      maxSlippageBps: this.cfg.maxSlippageBps,
    });

    if (!result.ok) {
      // all venues down / no quote / all rejected — saga will reverse fiat hold.
      return { ok: false, reason: result.reason };
    }

    // ---- SHORT-FILL GATE (notional reconciliation) ---------------------------
    // A PARTIAL slice or a later-slice rejection can leave the aggregate fill
    // worth LESS fiat than the customer is charged. Reconcile the fiat actually
    // spent against the requested notional; a short fill beyond a tiny tolerance
    // is a non-clean fill. We are still pre-commit, so reject -> saga reverses
    // the FULL fiat hold and nothing is delivered (no silent under-delivery).
    const requestedNotional = parseDecimal(spendMajor.toString());
    const spentNotional = parseDecimal(result.filledNotional);
    // Tolerance: maxSlippageBps of the requested notional (rounding / micro dust).
    const shortfall = requestedNotional - spentNotional;
    const notionalTolerance = (requestedNotional * BigInt(this.cfg.maxSlippageBps)) / BPS_DENOM;
    if (result.partial || shortfall > notionalTolerance) {
      const shortBps = requestedNotional > 0n
        ? (shortfall * BPS_DENOM) / requestedNotional
        : 0n;
      return {
        ok: false,
        reason: `SHORT_FILL:${shortBps.toString()}bps_under_notional@${result.venue}`,
      };
    }

    // ---- SLIPPAGE GATE (fee-aware, exact integer bps, no float) --------------
    // Gate on the buyer's NET (all-in) cost, not the raw price. Anchor to the
    // headline reference QUOTE price (what the customer expects to pay per unit)
    // and compare against the executed price grossed up by the WINNING venue's
    // taker fee. Because the fee is part of the all-in cost, a single venue (or
    // the winner) with an arbitrarily large taker fee can no longer pass at 0 bps
    // raw drift — its fee now counts directly against maxSlippageBps. The router's
    // reference NET price is still what RANKS venues; this gate bounds the cost.
    const referenceRaw = parseDecimal(result.referenceQuote.price);
    const executedNet = netPrice(parseDecimal(result.avgPrice), result.filledFeeBps);
    const drift = slippageBps(referenceRaw, executedNet); // >0 => all-in cost above quote
    if (drift > BigInt(this.cfg.maxSlippageBps)) {
      // Executed worse than tolerance. Abort — pre-commit, so this is SAFE; the
      // saga reverses the fiat auth and no crypto is delivered.
      return {
        ok: false,
        reason: `SLIPPAGE_EXCEEDED:${drift.toString()}bps>${this.cfg.maxSlippageBps}bps@${result.venue}`,
      };
    }

    return { ok: true, qty: result.filledQty, venue: result.venue };
  }
}
