/**
 * PROJECT TITAN — Compliance Engine (Phase 8) — implements the saga's CompliancePort
 *
 * The blocking gate (Principle P2). Runs, in order, the checks demanded by the
 * transaction's jurisdiction pack and the profile's KYC level. ANY failure =>
 * allow:false, which makes the saga VOID the fiat auth (REVERSED) and never
 * deliver crypto. Every sub-result is returned as a reason and (in prod) written
 * to the audit ledger + a compliance case when blocked.
 *
 * Decision: checks run in cost/severity order with early exit on a hard block
 * (sanctions, blocked wallet) to minimize vendor spend; KYC/Travel-Rule evaluated
 * for the audit trail regardless when reached.
 */
import { Injectable } from '@nestjs/common';
import { CompliancePort, TransactionContext } from '../transaction/transaction.saga';
import { KycPort, SanctionsPort, WalletScreeningPort, TravelRulePort } from './compliance.ports';
import { PACKS, requiredKyc, kycAtLeast } from './jurisdiction-packs';
import { toMinorUnits } from '../payment/auth-engine.service';

export interface ComplianceCaseStore {
  open(txnId: string, reasons: string[]): Promise<void>;
}

@Injectable()
export class ComplianceEngine implements CompliancePort {
  constructor(
    private readonly kyc: KycPort,
    private readonly sanctions: SanctionsPort,
    private readonly walletScreening: WalletScreeningPort,
    private readonly travelRule: TravelRulePort,
    private readonly cases: ComplianceCaseStore,
  ) {}

  async check(ctx: TransactionContext): Promise<{ allow: boolean; reasons: string[] }> {
    const reasons: string[] = [];
    const pack = PACKS[ctx.profile.dimensions.compliancePack] ?? PACKS.STRICT;
    const amountMinor = toMinorUnits(ctx.fiatAmount, ctx.fiatCurrency);

    // 1) Sanctions on the customer — hard block, screen first (cheap, severe).
    const custSanctions = await this.sanctions.screenCustomer(ctx.customerId ?? null);
    if (custSanctions.hit) {
      return this.block(ctx.id, [`SANCTIONS_HIT:${custSanctions.lists.join('+')}`]);
    }

    // 2) Counterparty wallet screening — irreversible send must not go to bad addr.
    if (pack.mandatoryWalletScreening && ctx.profile.dimensions.walletValidation.screenDestination) {
      const w = await this.walletScreening.screenAddress(ctx.chain, ctx.destWallet);
      if (w.blocked) {
        return this.block(ctx.id, [`WALLET_BLOCKED:${w.category ?? 'unknown'}`]);
      }
    }

    // 3) KYC level required by BOTH the profile floor AND the jurisdiction pack.
    const required = strictest(ctx.profile.dimensions.kycLevel, requiredKyc(pack, amountMinor));
    const status = await this.kyc.getStatus(ctx.customerId ?? null);
    if (status.status !== 'VERIFIED' || !kycAtLeast(status.level, required)) {
      return this.block(ctx.id, [`KYC_INSUFFICIENT:have=${status.level}/${status.status},need=${required}`]);
    }
    reasons.push(`KYC_OK:${status.level}`);

    // 4) Travel Rule — required transfers must be satisfied before delivery.
    const tr = await this.travelRule.evaluate({
      amountMinor, currency: ctx.fiatCurrency, chain: ctx.chain,
      destWallet: ctx.destWallet, customerId: ctx.customerId ?? null,
      thresholdMinor: pack.travelRuleThresholdMinor,
    });
    if (tr.required && !tr.satisfied) {
      return this.block(ctx.id, [...reasons, 'TRAVEL_RULE_UNSATISFIED']);
    }
    if (tr.required) reasons.push(`TRAVEL_RULE_OK:${tr.ref ?? ''}`);

    return { allow: true, reasons };
  }

  private async block(txnId: string, reasons: string[]) {
    await this.cases.open(txnId, reasons);
    return { allow: false, reasons };
  }
}

function strictest(a: import('@titan/profile-schema').KycLevel, b: import('@titan/profile-schema').KycLevel) {
  const order = ['NONE', 'BASIC', 'FULL', 'FULL_LIVENESS', 'ENHANCED'];
  return order.indexOf(a) >= order.indexOf(b) ? a : b;
}
