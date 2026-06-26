/**
 * PROJECT TITAN — Blockchain delivery engine tests (Phase 6)
 *
 * Proves the safety-critical invariants of the universal delivery engine:
 *   - address validation per family (real mainnet vectors; testnet rejected),
 *   - chain detection + declared-chain enforcement for ambiguous EVM addresses,
 *   - float-free decimal -> integer base-unit conversion,
 *   - idempotent no-double-send on retry,
 *   - confirmation polling with a single fee bump, DROPPED, and budget exhaustion.
 *
 * All deterministic + no network (injected NodeClient + instant clock).
 */
import {
  validateAddress, detectChains, validateBtcAddress, validateEvmAddress,
  validateTronAddress, validateSolanaAddress, toEip55Checksum,
} from './address';
import { toBaseUnits, fromBaseUnits } from './base-units';
import { getChain } from './chains';
import {
  ChainDeliveryEngine, validateDestination, DeliveryEngineDeps,
} from './delivery.engine';
import {
  InMemoryNode, InMemoryIdempotencyStore, instantClock, InMemoryNodeConfig,
} from './testing/in-memory-node';
import { WalletValidation } from '@titan/profile-schema';

// ---- real mainnet address vectors ----
const BTC_P2PKH = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'; // genesis coinbase
const BTC_P2SH = '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy';
const BTC_BECH32 = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'; // P2WPKH v0
const BTC_TAPROOT = 'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0'; // v1
const BTC_TESTNET = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
const EVM_CHECKSUM = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const EVM_BAD_CHECKSUM = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1Beaed';
const TRON_ADDR = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'; // USDT-TRC20 contract addr
const SOL_ADDR = '11111111111111111111111111111112'; // System program (32 bytes)

const wvLoose: WalletValidation = { enforceChecksum: false, screenDestination: false, blockMixers: false };
const wvStrict: WalletValidation = { enforceChecksum: true, screenDestination: true, blockMixers: true };

describe('address validation per family', () => {
  it('accepts BTC P2PKH/P2SH/bech32/taproot mainnet', () => {
    expect(validateBtcAddress(BTC_P2PKH).valid).toBe(true);
    expect(validateBtcAddress(BTC_P2SH).valid).toBe(true);
    expect(validateBtcAddress(BTC_BECH32).valid).toBe(true);
    expect(validateBtcAddress(BTC_TAPROOT).valid).toBe(true);
  });

  it('rejects BTC testnet and corrupted checksums', () => {
    expect(validateBtcAddress(BTC_TESTNET).valid).toBe(false);
    expect(validateBtcAddress(BTC_TESTNET).reason).toBe('TESTNET');
    expect(validateBtcAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb').valid).toBe(false); // bad cksum
  });

  it('EVM: accepts good checksum, all-lower, all-upper; rejects bad checksum', () => {
    expect(validateEvmAddress(EVM_CHECKSUM).valid).toBe(true);
    expect(validateEvmAddress(EVM_CHECKSUM.toLowerCase()).valid).toBe(true);
    expect(validateEvmAddress('0x' + EVM_CHECKSUM.slice(2).toUpperCase()).valid).toBe(true);
    expect(validateEvmAddress(EVM_BAD_CHECKSUM).valid).toBe(false);
    expect(validateEvmAddress(EVM_BAD_CHECKSUM).reason).toBe('BAD_CHECKSUM');
  });

  it('EIP-55 checksum matches the canonical reference vector', () => {
    expect('0x' + toEip55Checksum(EVM_CHECKSUM.slice(2).toLowerCase())).toBe(EVM_CHECKSUM);
  });

  it('TRON: accepts mainnet T-address, rejects EVM/garbage', () => {
    expect(validateTronAddress(TRON_ADDR).valid).toBe(true);
    expect(validateTronAddress(EVM_CHECKSUM).valid).toBe(false);
  });

  it('SOLANA: accepts 32-byte base58, rejects wrong length', () => {
    expect(validateSolanaAddress(SOL_ADDR).valid).toBe(true);
    expect(validateSolanaAddress('abc').valid).toBe(false);
  });

  it('dispatcher routes by chain family', () => {
    expect(validateAddress('ethereum', EVM_CHECKSUM).valid).toBe(true);
    expect(validateAddress('polygon', EVM_CHECKSUM).valid).toBe(true);
    expect(validateAddress('bitcoin', BTC_BECH32).valid).toBe(true);
    expect(validateAddress('tron', TRON_ADDR).valid).toBe(true);
    expect(validateAddress('solana', SOL_ADDR).valid).toBe(true);
    // BTC address on an EVM chain -> rejected (family mismatch).
    expect(validateAddress('ethereum', BTC_BECH32).valid).toBe(false);
  });
});

describe('chain detection requires explicit chain when ambiguous', () => {
  it('EVM address is a candidate on every EVM chain', () => {
    const cands = detectChains(EVM_CHECKSUM).map((c) => c.chainId);
    expect(cands).toEqual(expect.arrayContaining(['ethereum', 'polygon', 'arbitrum', 'optimism', 'base', 'bnb']));
    expect(cands).not.toContain('bitcoin');
  });

  it('non-EVM addresses resolve to exactly one chain', () => {
    expect(detectChains(BTC_BECH32).map((c) => c.chainId)).toEqual(['bitcoin']);
    expect(detectChains(SOL_ADDR).map((c) => c.chainId)).toEqual(['solana']);
  });
});

describe('float-free base-unit conversion', () => {
  it('converts BTC/ETH/SOL exactly with no precision loss', () => {
    expect(toBaseUnits('0.1', 8)).toBe(10000000n);
    expect(toBaseUnits('1.5', 18)).toBe(1500000000000000000n);
    expect(toBaseUnits('1', 9)).toBe(1000000000n);
    expect(toBaseUnits('0.00000001', 8)).toBe(1n);
  });

  it('rejects over-precise amounts rather than rounding money', () => {
    expect(() => toBaseUnits('0.000000001', 8)).toThrow(/TOO_PRECISE/);
    expect(() => toBaseUnits('1.2.3', 8)).toThrow();
    expect(() => toBaseUnits('-1', 8)).toThrow(/NEGATIVE/);
  });

  it('round-trips through fromBaseUnits', () => {
    expect(fromBaseUnits(1500000000000000000n, 18)).toBe('1.5');
    expect(fromBaseUnits(10000000n, 8)).toBe('0.1');
  });
});

describe('validateDestination pre-commit gate', () => {
  it('enforces EIP-55 checksum on EVM when profile demands it', () => {
    expect(validateDestination('ethereum', EVM_CHECKSUM.toLowerCase(), wvStrict).valid).toBe(false);
    expect(validateDestination('ethereum', EVM_CHECKSUM.toLowerCase(), wvStrict).reason).toBe('CHECKSUM_REQUIRED');
    expect(validateDestination('ethereum', EVM_CHECKSUM, wvStrict).valid).toBe(true);
    // checksum not enforced -> all-lower accepted.
    expect(validateDestination('ethereum', EVM_CHECKSUM.toLowerCase(), wvLoose).valid).toBe(true);
  });
});

// ---- engine harness ----
function makeEngine(node: InMemoryNode, store = new InMemoryIdempotencyStore(), policy = {}) {
  const deps: DeliveryEngineDeps = {
    nodeFor: () => node,
    idempotency: store,
    clock: instantClock,
    policy: { maxAttempts: 30, pollIntervalMs: 1, pendingBeforeBump: 3, ...policy },
  };
  return { engine: new ChainDeliveryEngine(deps), store };
}

function ctx(over: Partial<any> = {}): any {
  return {
    id: 'txn-1',
    chain: 'ethereum',
    asset: 'ETH',
    destWallet: EVM_CHECKSUM,
    profile: { dimensions: { walletValidation: wvLoose } },
    ...over,
  };
}

describe('send: validation, base units, idempotency', () => {
  it('broadcasts and returns a txid; amount converted to wei', async () => {
    const node = new InMemoryNode();
    const { engine } = makeEngine(node);
    const res = await engine.send(ctx(), '1.5');
    expect(res.ok).toBe(true);
    expect(res.txid).toBe('tx-delivery:txn-1');
    expect(node.broadcasts[0].amountBaseUnits).toBe('1500000000000000000');
    expect(node.broadcasts[0].evmChainId).toBe(1);
  });

  it('rejects a destination that does not match the declared chain', async () => {
    const node = new InMemoryNode();
    const { engine } = makeEngine(node);
    const res = await engine.send(ctx({ destWallet: BTC_BECH32 }), '1');
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/INVALID_DESTINATION/);
    expect(node.broadcasts.length).toBe(0);
  });

  it('NEVER double-sends: a retried send returns the recorded txid', async () => {
    const node = new InMemoryNode();
    const { engine, store } = makeEngine(node);
    const first = await engine.send(ctx(), '1');
    const second = await engine.send(ctx(), '1');
    expect(first.txid).toBe(second.txid);
    expect(node.broadcasts.length).toBe(1); // only ONE broadcast
    expect(await store.wasSent('delivery:txn-1')).toBe(first.txid);
  });

  it('reports a broadcast failure without recording idempotency', async () => {
    const node = new InMemoryNode({ failBroadcast: 'NODE_REJECTED' });
    const { engine, store } = makeEngine(node);
    const res = await engine.send(ctx(), '1');
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/BROADCAST_FAILED/);
    expect(await store.wasSent('delivery:txn-1')).toBeNull();
  });

  it('a released reservation lets a genuine retry re-broadcast after a transient failure', async () => {
    // First send fails before submit -> reservation released. A later send (the
    // failure cleared) re-claims and broadcasts exactly once.
    const flaky = new InMemoryNode();
    let fail = true;
    const node: InMemoryNode = Object.assign(flaky, {
      broadcast: async (intent: any) => {
        if (fail) { fail = false; throw new Error('NODE_TIMEOUT'); }
        return InMemoryNode.prototype.broadcast.call(flaky, intent);
      },
    });
    const { engine } = makeEngine(node);
    const first = await engine.send(ctx(), '1');
    expect(first.ok).toBe(false);
    const second = await engine.send(ctx(), '1');
    expect(second.ok).toBe(true);
    expect(flaky.broadcasts.length).toBe(1); // exactly one successful broadcast
  });

  // ---- FINDING #3: concurrent (TOCTOU) redelivery must NOT double-broadcast. ----
  it('CONCURRENT same-id sends broadcast at most ONCE (no TOCTOU double-spend)', async () => {
    // A node that assigns a UNIQUE txid per broadcast (as a real chain does) and
    // yields the event loop mid-broadcast, so two concurrent sends of the SAME
    // deliveryId interleave between reserve and broadcast.
    const broadcasts: any[] = [];
    let seq = 0;
    const node: any = {
      broadcast: async (intent: any) => {
        await Promise.resolve(); // force an await point so the two sends interleave
        broadcasts.push(intent);
        return { txid: `tx-${intent.deliveryId}-${seq++}` };
      },
      getStatus: async () => ({ confirmations: 12, status: 'CONFIRMED' }),
      suggestFee: async () => ({ feeRate: '10' }),
      bumpFee: async (txid: string) => ({ txid }),
    };
    const { engine, store } = makeEngine(node);

    const [r1, r2] = await Promise.allSettled([
      engine.send(ctx(), '1'),
      engine.send(ctx(), '1'),
    ]);

    expect(broadcasts.length).toBe(1);                 // the money left at most ONCE
    const recorded = await store.wasSent('delivery:txn-1');
    expect(recorded).toBeTruthy();
    // At least one caller succeeds; neither caller triggers a second broadcast.
    const oks = [r1, r2].filter((r) => r.status === 'fulfilled' && (r.value as any).ok);
    expect(oks.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects over-precise amounts before broadcasting', async () => {
    const node = new InMemoryNode();
    const { engine } = makeEngine(node);
    const res = await engine.send(ctx({ chain: 'bitcoin', destWallet: BTC_BECH32 }), '0.000000001');
    expect(res.ok).toBe(false);
    expect(node.broadcasts.length).toBe(0);
  });
});

describe('awaitConfirmations: confirm, bump, drop, budget', () => {
  it('returns true once requiredConfirmations is reached', async () => {
    // ethereum needs 12; ramp to 12.
    const node = new InMemoryNode({ confirmationsOverCalls: [0, 3, 12], confirmedAt: 12 });
    const { engine } = makeEngine(node);
    expect(await engine.awaitConfirmations('tx-1', 'ethereum')).toBe(true);
  });

  it('bumps the fee ONCE when stuck PENDING, then confirms', async () => {
    // stays at 0 (PENDING) for several polls -> triggers a single bump -> then confirms.
    const node = new InMemoryNode({
      confirmationsOverCalls: [0, 0, 0, 0, 0, 12],
      confirmedAt: 12,
      bumpYieldsNewTxid: true,
    });
    const { engine } = makeEngine(node, new InMemoryIdempotencyStore(), { pendingBeforeBump: 3 });
    expect(await engine.awaitConfirmations('tx-1', 'ethereum')).toBe(true);
    expect(node.bumpCalls).toBe(1); // exactly one bump
  });

  it('returns false on DROPPED', async () => {
    const node = new InMemoryNode({ dropAfterCalls: 2 });
    const { engine } = makeEngine(node);
    expect(await engine.awaitConfirmations('tx-1', 'ethereum')).toBe(false);
  });

  it('returns false when the attempt budget is exhausted', async () => {
    const node = new InMemoryNode({ confirmationsOverCalls: [0], confirmedAt: 12 }); // never confirms
    const { engine } = makeEngine(node, new InMemoryIdempotencyStore(), { maxAttempts: 5 });
    expect(await engine.awaitConfirmations('tx-1', 'ethereum')).toBe(false);
    expect(node.statusCalls).toBe(5);
  });
});

describe('chain registry sanity', () => {
  it('EVM chains share the family and carry distinct evmChainIds', () => {
    expect(getChain('arbitrum').evmChainId).toBe(42161);
    expect(getChain('base').evmChainId).toBe(8453);
    expect(getChain('bnb').family).toBe('EVM');
    expect(getChain('bitcoin').nativeDecimals).toBe(8);
    expect(getChain('solana').baseUnitName).toBe('lamport');
  });
});
