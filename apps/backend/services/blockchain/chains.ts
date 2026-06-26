/**
 * PROJECT TITAN — Universal Chain Registry (Phase 6)
 *
 * The single source of truth for every chain the delivery engine can reach.
 * Address validation, base-unit math, and the confirmation poller all read
 * their parameters from here — there are NO magic numbers anywhere else.
 *
 * `family` collapses the per-chain quirks into four address/transaction shapes:
 *   - EVM    : EIP-55 hex addresses, all EVM chains share one validator and
 *              one sender (distinguished only by `evmChainId`).
 *   - BTC    : base58check (P2PKH/P2SH) + bech32/bech32m (segwit v0/v1).
 *   - TRON   : base58check with a 0x41 version prefix.
 *   - SOLANA : raw base58 of a 32-byte ed25519 public key.
 *
 * `nativeDecimals` is the number of decimal places between the human-facing
 * quote unit and the integer base unit (BTC: 8 -> satoshi, ETH: 18 -> wei,
 * SOL: 9 -> lamport). This is what the BigInt converter uses; it MUST be exact.
 */

export type ChainFamily = 'EVM' | 'BTC' | 'TRON' | 'SOLANA';

export interface ChainSpec {
  /** Stable lowercase id used by ctx.chain and the engine dispatcher. */
  id: string;
  family: ChainFamily;
  /** EIP-155 numeric chain id; present only for the EVM family. */
  evmChainId?: number;
  /** Decimals between the quote unit and the integer base unit. */
  nativeDecimals: number;
  /** Confirmations the poller waits for before declaring delivery final. */
  requiredConfirmations: number;
  /** Name of the smallest indivisible unit (satoshi/wei/lamport/sun). */
  baseUnitName: string;
}

/**
 * The registry. Confirmation counts reflect common custody-grade thresholds:
 * Bitcoin's slow blocks demand fewer but heavier confirmations; fast EVM L2s
 * and Solana need more cheap blocks for equivalent finality assurance.
 */
export const CHAINS: Record<string, ChainSpec> = {
  bitcoin:  { id: 'bitcoin',  family: 'BTC',    nativeDecimals: 8,  requiredConfirmations: 3,  baseUnitName: 'satoshi' },

  ethereum: { id: 'ethereum', family: 'EVM', evmChainId: 1,     nativeDecimals: 18, requiredConfirmations: 12, baseUnitName: 'wei' },
  polygon:  { id: 'polygon',  family: 'EVM', evmChainId: 137,   nativeDecimals: 18, requiredConfirmations: 30, baseUnitName: 'wei' },
  arbitrum: { id: 'arbitrum', family: 'EVM', evmChainId: 42161, nativeDecimals: 18, requiredConfirmations: 20, baseUnitName: 'wei' },
  optimism: { id: 'optimism', family: 'EVM', evmChainId: 10,    nativeDecimals: 18, requiredConfirmations: 20, baseUnitName: 'wei' },
  base:     { id: 'base',     family: 'EVM', evmChainId: 8453,  nativeDecimals: 18, requiredConfirmations: 20, baseUnitName: 'wei' },
  bnb:      { id: 'bnb',      family: 'EVM', evmChainId: 56,    nativeDecimals: 18, requiredConfirmations: 15, baseUnitName: 'wei' },

  tron:     { id: 'tron',     family: 'TRON',   nativeDecimals: 6,  requiredConfirmations: 20, baseUnitName: 'sun' },
  solana:   { id: 'solana',   family: 'SOLANA', nativeDecimals: 9,  requiredConfirmations: 32, baseUnitName: 'lamport' },
};

/** Convenience aliases so callers can pass common synonyms for a chain id. */
const ALIASES: Record<string, string> = {
  btc: 'bitcoin',
  eth: 'ethereum',
  matic: 'polygon',
  'polygon-pos': 'polygon',
  arb: 'arbitrum',
  op: 'optimism',
  'bnb-chain': 'bnb',
  bsc: 'bnb',
  trx: 'tron',
  sol: 'solana',
};

/** Normalize a user/profile-supplied chain id to a canonical registry key. */
export function canonicalChainId(chain: string): string {
  const k = chain.trim().toLowerCase();
  return ALIASES[k] ?? k;
}

/** Look up a chain spec or throw — unknown chains must never silently pass. */
export function getChain(chain: string): ChainSpec {
  const spec = CHAINS[canonicalChainId(chain)];
  if (!spec) throw new Error(`UNKNOWN_CHAIN:${chain}`);
  return spec;
}

/** Soft lookup used on hot paths where a boolean is cleaner than a throw. */
export function tryGetChain(chain: string): ChainSpec | undefined {
  return CHAINS[canonicalChainId(chain)];
}

export function isEvm(chain: string): boolean {
  return tryGetChain(chain)?.family === 'EVM';
}
