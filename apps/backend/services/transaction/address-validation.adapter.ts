/**
 * PROJECT TITAN — Pre-commit address-validation adapter (Phase 6 wiring)
 *
 * Bridges the saga's hexagonal `AddressValidationPort` to the blockchain
 * package's pure `validateDestination(chain, address, walletValidation)`. The
 * saga stays decoupled from the chain registry; this adapter is the single
 * place that knows both.
 *
 * It is invoked PRE-COMMIT (still in RISK_REVIEW, fiat reversible) so an invalid
 * or chain-mismatched destination compensates to REVERSED having placed ZERO
 * exchange orders. The delivery engine re-runs `validateDestination` post-commit
 * as defense-in-depth — this gate is the bright line that prevents ever buying
 * crypto we cannot deliver.
 */
import { AddressValidationPort, TransactionContext } from './transaction.saga';
import { validateDestination } from '../blockchain/delivery.engine';
import { WalletValidation } from '@titan/profile-schema';

/** Fail-closed wallet policy if a profile somehow omits one. */
const STRICT_FALLBACK: WalletValidation = {
  enforceChecksum: true,
  screenDestination: true,
  blockMixers: true,
};

export class BlockchainAddressValidationAdapter implements AddressValidationPort {
  validate(ctx: TransactionContext): { valid: boolean; reason?: string } {
    const wv = ctx.profile?.dimensions?.walletValidation ?? STRICT_FALLBACK;
    const res = validateDestination(ctx.chain, ctx.destWallet, wv);
    return { valid: res.valid, reason: res.reason };
  }
}
