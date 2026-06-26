/**
 * PROJECT TITAN — Authorization Engine (Phase 4)
 *
 * Implements the saga's AuthPort. Converts a TransactionContext into a normalized
 * gateway authorize/void via the router-selected acquirer. Holds the network ref
 * so a later compliance/risk failure can VOID the exact authorization.
 *
 * Money is handled in integer minor units end-to-end (no floats).
 */
import { Injectable } from '@nestjs/common';
import { AuthPort, TransactionContext } from '../transaction/transaction.saga';
import { PaymentRouter } from './payment-router.service';

/** Tiny store mapping a transaction -> the acquirer ref needed to void it. */
export interface AuthRefStore {
  put(txnId: string, ref: { processor: string; networkRef: string; routeId: string }): Promise<void>;
  get(txnId: string): Promise<{ processor: string; networkRef: string; routeId: string } | null>;
}

export function toMinorUnits(amount: number, currency: string): number {
  // currencies with non-2 exponents would be looked up; default 2 here.
  const exponent = currency === 'JPY' ? 0 : 2;
  return Math.round(amount * 10 ** exponent);
}

@Injectable()
export class AuthEngine implements AuthPort {
  constructor(
    private readonly router: PaymentRouter,
    private readonly refs: AuthRefStore,
  ) {}

  async authorize(ctx: TransactionContext) {
    const { route, adapter } = await this.router.pick(
      ctx.profile.dimensions.processorRoute,
      ctx.fiatCurrency,
    );
    const result = await adapter.authorize({
      idempotencyKey: `auth:${ctx.id}`,
      route,
      // When the txn is priced (revenue model), authorize the EXACT charged amount
      // from the quote — already float-safe integer minor units. Else fall back to
      // the legacy conversion of the headline fiatAmount.
      amountMinor: ctx.priceQuote
        ? Number(ctx.priceQuote.fiatChargedMinor)
        : toMinorUnits(ctx.fiatAmount, ctx.fiatCurrency),
      currency: ctx.fiatCurrency,
      cardToken: ctx.cardToken ?? '',
      reference: ctx.id,
      preAuth: ctx.profile.dimensions.approvalPolicy.preAuth,
    });

    if (result.ok && result.networkRef) {
      await this.refs.put(ctx.id, { processor: adapter.processor, networkRef: result.networkRef, routeId: route.routeId });
    }
    return { ok: result.ok, authCode: result.authCode, reason: result.reason };
  }

  async void(ctx: TransactionContext): Promise<void> {
    const ref = await this.refs.get(ctx.id);
    if (!ref) return; // nothing authorized -> nothing to void (idempotent)
    const { route, adapter } = await this.router.pick(ref.routeId, ctx.fiatCurrency);
    const res = await adapter.void({
      idempotencyKey: `void:${ctx.id}`,
      route,
      networkRef: ref.networkRef,
      reference: ctx.id,
    });
    if (!res.ok) {
      // surface to caller -> saga opens a treasury reconciliation case
      throw new Error(`void failed for ${ctx.id}: ${res.reason ?? 'unknown'}`);
    }
  }
}
