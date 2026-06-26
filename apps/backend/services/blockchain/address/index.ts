/**
 * PROJECT TITAN — Address validation dispatcher + chain detection (Phase 6)
 *
 * `validateAddress(chain, address)` routes to the per-family validator chosen by
 * the chain registry. Because an EVM hex address is structurally valid on EVERY
 * EVM chain, the engine cannot infer the destination chain from the address
 * alone — so `detectChains(address)` returns the full candidate set and the
 * delivery engine REQUIRES the caller's explicit `ctx.chain`, rejecting any
 * address whose family does not match the declared chain (see delivery.engine).
 */
import { CHAINS, ChainFamily, getChain } from '../chains';
import { AddressCheck, fail } from './types';
import { validateEvmAddress } from './evm';
import { validateBtcAddress } from './btc';
import { validateTronAddress } from './tron';
import { validateSolanaAddress } from './solana';

export * from './types';
export { validateEvmAddress, checksumEvmAddress, toEip55Checksum } from './evm';
export { validateBtcAddress } from './btc';
export { validateTronAddress } from './tron';
export { validateSolanaAddress } from './solana';

const VALIDATORS: Record<ChainFamily, (a: string) => AddressCheck> = {
  EVM: validateEvmAddress,
  BTC: validateBtcAddress,
  TRON: validateTronAddress,
  SOLANA: validateSolanaAddress,
};

/** Validate `address` against the family of `chain` (throws if chain unknown). */
export function validateAddress(chain: string, address: string): AddressCheck {
  const spec = getChain(chain);
  return VALIDATORS[spec.family](address);
}

/** Validate `address` against a family directly (used by detection internals). */
export function validateForFamily(family: ChainFamily, address: string): AddressCheck {
  return VALIDATORS[family](address);
}

export interface ChainCandidate {
  chainId: string;
  family: ChainFamily;
}

/**
 * Return every registered chain on which `address` is structurally valid.
 *
 * - A BTC / TRON / SOLANA address resolves to exactly one chain.
 * - An EVM address is ambiguous: it is valid on ALL EVM chains, so every EVM
 *   chain is returned. Callers MUST then pin the chain with ctx.chain; the
 *   engine refuses to guess which EVM network a hex address belongs to.
 */
export function detectChains(address: string): ChainCandidate[] {
  // Determine which families accept this address, then expand to chains.
  const families = new Set<ChainFamily>();
  for (const family of ['EVM', 'BTC', 'TRON', 'SOLANA'] as ChainFamily[]) {
    if (VALIDATORS[family](address).valid) families.add(family);
  }
  const out: ChainCandidate[] = [];
  for (const spec of Object.values(CHAINS)) {
    if (families.has(spec.family)) out.push({ chainId: spec.id, family: spec.family });
  }
  return out;
}

/** True when `address` is valid on `chain`'s family AND no family conflict. */
export function isAddressForChain(chain: string, address: string): AddressCheck {
  const spec = getChain(chain);
  const res = VALIDATORS[spec.family](address);
  if (!res.valid) return res;
  return { valid: true };
}

export { fail };
