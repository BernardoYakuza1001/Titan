/**
 * PROJECT TITAN — Universal Blockchain Delivery unit proof (integration owner).
 *
 * Covers the POST-COMMIT money-mover's safety-critical surface with REAL code
 * (validators, base-unit math, ChainDeliveryEngine) and injected fakes — no
 * network, deterministic clock:
 *
 *   - per-family address validation with REAL valid + invalid mainnet vectors
 *     (BTC legacy + bech32, EVM good/bad/all-lower checksum, Tron, Solana);
 *   - chain-mismatch rejection (a BTC address on an EVM chain is refused);
 *   - decimal-string -> BigInt base-unit conversion exactness (no float, no round);
 *   - idempotent send: a second send returns the same txid with ONE broadcast;
 *   - awaitConfirmations reaches CONFIRMED;
 *   - awaitConfirmations returns false on DROPPED and on budget exhaustion,
 *     exercising the stuck-PENDING -> single fee bump path.
 */
import {
  validateAddress, validateBtcAddress, validateEvmAddress,
  validateTronAddress, validateSolanaAddress,
} from '../services/blockchain/address';
import { toBaseUnits, fromBaseUnits } from '../services/blockchain/base-units';
import {
  ChainDeliveryEngine, validateDestination, DeliveryEngineDeps,
} from '../services/blockchain/delivery.engine';
import {
  InMemoryNode, InMemoryIdempotencyStore, instantClock,
} from '../services/blockchain/testing/in-memory-node';
import { WalletValidation } from '@titan/profile-schema';

// ---- REAL mainnet address vectors ----
const BTC_P2PKH = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';                    // genesis coinbase (legacy P2PKH)
const BTC_BECH32 = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';           // P2WPKH (bech32 v0)
const BTC_TESTNET = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';          // testnet -> must reject
const EVM_CHECKSUM = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';         // valid EIP-55
const EVM_BAD_CHECKSUM = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1Beaed';     // one nibble case wrong
const TRON_ADDR = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';                    // USDT-TRC20 contract
const SOL_ADDR = '11111111111111111111111111111112';                      // System program (32 bytes)

const wvLoose: WalletValidation = { enforceChecksum: false, screenDestination: false, blockMixers: false };
const wvStrict: WalletValidation = { enforceChecksum: true, screenDestination: true, blockMixers: true };

describe('address validators — real vectors', () => {
  it('BTC: accepts legacy P2PKH + bech32, rejects testnet + corrupted checksum', () => {
    expect(validateBtcAddress(BTC_P2PKH).valid).toBe(true);
    expect(validateBtcAddress(BTC_BECH32).valid).toBe(true);
    expect(validateBtcAddress(BTC_TESTNET).valid).toBe(false);
    expect(validateBtcAddress(BTC_TESTNET).reason).toBe('TESTNET');
    // flip the last char of the genesis address -> base58check fails.
    expect(validateBtcAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb').valid).toBe(false);
  });

  it('EVM: accepts good checksum + all-lower, rejects a bad checksum', () => {
    expect(validateEvmAddress(EVM_CHECKSUM).valid).toBe(true);
    expect(validateEvmAddress(EVM_CHECKSUM.toLowerCase()).valid).toBe(true); // single-case ok
    expect(validateEvmAddress(EVM_BAD_CHECKSUM).valid).toBe(false);
    expect(validateEvmAddress(EVM_BAD_CHECKSUM).reason).toBe('BAD_CHECKSUM');
  });

  it('Tron: accepts a mainnet T-address, rejects an EVM hex address', () => {
    expect(validateTronAddress(TRON_ADDR).valid).toBe(true);
    expect(validateTronAddress(EVM_CHECKSUM).valid).toBe(false);
  });

  it('Solana: accepts a 32-byte base58 key, rejects wrong length', () => {
    expect(validateSolanaAddress(SOL_ADDR).valid).toBe(true);
    expect(validateSolanaAddress('abc').valid).toBe(false);
  });
});

describe('chain-mismatch rejection', () => {
  it('a BTC address on an EVM chain is refused (family mismatch)', () => {
    // structurally fine for BTC, but the declared chain is EVM -> reject.
    expect(validateAddress('bitcoin', BTC_BECH32).valid).toBe(true);
    expect(validateAddress('ethereum', BTC_BECH32).valid).toBe(false);
  });

  it('validateDestination enforces the declared chain + checksum policy', () => {
    // all-lower EVM address with checksum ENFORCED -> rejected pre-commit.
    const lowered = validateDestination('ethereum', EVM_CHECKSUM.toLowerCase(), wvStrict);
    expect(lowered.valid).toBe(false);
    expect(lowered.reason).toBe('CHECKSUM_REQUIRED');
    // same address, checksum NOT enforced -> accepted.
    expect(validateDestination('ethereum', EVM_CHECKSUM.toLowerCase(), wvLoose).valid).toBe(true);
    // chain-mismatched destination -> rejected.
    expect(validateDestination('ethereum', BTC_BECH32, wvStrict).valid).toBe(false);
    // unknown chain -> rejected, never silently passes.
    expect(validateDestination('dogecoin', EVM_CHECKSUM, wvStrict).valid).toBe(false);
    expect(validateDestination('dogecoin', EVM_CHECKSUM, wvStrict).reason).toBe('UNKNOWN_CHAIN');
  });
});

describe('decimal-string -> BigInt base-unit conversion exactness', () => {
  it('converts exactly with no float / no rounding (BTC 8dp, ETH 18dp, SOL 9dp)', () => {
    expect(toBaseUnits('0.1', 8)).toBe(10_000_000n);
    expect(toBaseUnits('0.00000001', 8)).toBe(1n);                       // 1 satoshi
    expect(toBaseUnits('1.5', 18)).toBe(1_500_000_000_000_000_000n);     // 1.5 ETH in wei
    expect(toBaseUnits('1', 9)).toBe(1_000_000_000n);                    // 1 SOL in lamports
    // value that breaks IEEE-754 doubles must round-trip exactly here.
    expect(toBaseUnits('0.1', 18)).toBe(100_000_000_000_000_000n);
  });

  it('rejects over-precise amounts rather than silently rounding money', () => {
    expect(() => toBaseUnits('0.000000001', 8)).toThrow(/TOO_PRECISE/); // 9dp on an 8dp chain
    expect(() => toBaseUnits('-1', 8)).toThrow(/NEGATIVE/);
    expect(() => toBaseUnits('1.2.3', 8)).toThrow();
  });

  it('round-trips through fromBaseUnits', () => {
    expect(fromBaseUnits(toBaseUnits('1.5', 18), 18)).toBe('1.5');
    expect(fromBaseUnits(toBaseUnits('0.1', 8), 8)).toBe('0.1');
  });
});

// ---- engine harness (injected node + idempotency store + instant clock) ----
function makeEngine(node: InMemoryNode, store = new InMemoryIdempotencyStore(), policy = {}) {
  const deps: DeliveryEngineDeps = {
    nodeFor: () => node,
    idempotency: store,
    clock: instantClock,
    policy: { maxAttempts: 40, pollIntervalMs: 1, pendingBeforeBump: 3, ...policy },
  };
  return { engine: new ChainDeliveryEngine(deps), store };
}

function ctx(over: Partial<any> = {}): any {
  return {
    id: 'txn-blk-1',
    chain: 'ethereum',
    asset: 'ETH',
    destWallet: EVM_CHECKSUM,
    profile: { dimensions: { walletValidation: wvLoose } },
    ...over,
  };
}

describe('send — base units, validation, idempotent no-double-send', () => {
  it('broadcasts once and converts the amount to integer base units (wei)', async () => {
    const node = new InMemoryNode();
    const { engine } = makeEngine(node);
    const res = await engine.send(ctx(), '1.5');
    expect(res.ok).toBe(true);
    expect(res.txid).toBe('tx-delivery:txn-blk-1');
    expect(node.broadcasts[0].amountBaseUnits).toBe('1500000000000000000'); // BigInt string, no float
    expect(node.broadcasts[0].evmChainId).toBe(1);
  });

  it('idempotent send: a second send returns the SAME txid, only ONE broadcast', async () => {
    const node = new InMemoryNode();
    const { engine, store } = makeEngine(node);
    const first = await engine.send(ctx(), '1');
    const second = await engine.send(ctx(), '1');          // retry / redelivery
    expect(first.ok).toBe(true);
    expect(first.txid).toBe(second.txid);
    expect(node.broadcasts.length).toBe(1);                // exactly ONE on-chain broadcast
    expect(await store.wasSent('delivery:txn-blk-1')).toBe(first.txid);
  });

  it('rejects a chain-mismatched destination before any broadcast', async () => {
    const node = new InMemoryNode();
    const { engine } = makeEngine(node);
    const res = await engine.send(ctx({ destWallet: BTC_BECH32 }), '1'); // BTC addr on ethereum
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/INVALID_DESTINATION/);
    expect(node.broadcasts.length).toBe(0);
  });
});

describe('awaitConfirmations — confirm, drop, budget, fee bump', () => {
  it('reaches CONFIRMED once requiredConfirmations is met', async () => {
    // ethereum requires 12; ramp the confirmation curve up to 12.
    const node = new InMemoryNode({ confirmationsOverCalls: [0, 3, 12], confirmedAt: 12 });
    const { engine } = makeEngine(node);
    expect(await engine.awaitConfirmations('tx-1', 'ethereum')).toBe(true);
  });

  it('returns false on DROPPED', async () => {
    const node = new InMemoryNode({ dropAfterCalls: 2 });
    const { engine } = makeEngine(node);
    expect(await engine.awaitConfirmations('tx-1', 'ethereum')).toBe(false);
  });

  it('stuck PENDING -> single fee bump -> then confirms', async () => {
    // sits at 0 (PENDING) past the bump threshold, then jumps to confirmed depth.
    const node = new InMemoryNode({
      confirmationsOverCalls: [0, 0, 0, 0, 0, 12],
      confirmedAt: 12,
      bumpYieldsNewTxid: true,
    });
    const { engine } = makeEngine(node, new InMemoryIdempotencyStore(), { pendingBeforeBump: 3 });
    expect(await engine.awaitConfirmations('tx-1', 'ethereum')).toBe(true);
    expect(node.bumpCalls).toBe(1); // exactly ONE bump, never spams replacements
  });

  it('returns false when the attempt budget is exhausted (never confirms)', async () => {
    const node = new InMemoryNode({ confirmationsOverCalls: [0], confirmedAt: 12 });
    const { engine } = makeEngine(node, new InMemoryIdempotencyStore(), { maxAttempts: 5 });
    expect(await engine.awaitConfirmations('tx-1', 'ethereum')).toBe(false);
    expect(node.statusCalls).toBe(5); // bounded by the budget
  });
});
