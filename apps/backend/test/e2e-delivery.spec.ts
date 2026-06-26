/**
 * PROJECT TITAN — END-TO-END DELIVERY PROOF (the headline; integration owner).
 *
 * Builds the REAL TransactionSaga with the REAL CryptoExecEngine and the REAL
 * ChainDeliveryEngine — only the network edges are faked (Adyen HttpClient,
 * exchange venues via InMemoryExchange, chain node via InMemoryNode) — plus the
 * existing AuthEngine + ComplianceEngine and the new pre-commit address gate.
 *
 * It proves the bright line between the REVERSIBLE (pre-crypto) and IRREVERSIBLE
 * (post-crypto) sides of a fiat->crypto transaction:
 *
 *   a) happy path                 -> COMPLETED; a best venue chosen; txid exists;
 *                                    confirmations reached.
 *   b) slippage breach            -> REVERSED; fiat voided; NO on-chain broadcast.
 *   c) all venues down            -> REVERSED; NO broadcast.
 *   d) invalid / chain-mismatched -> REVERSED PRE-buy; ZERO exchange orders placed.
 *      destination address           (we never bought what we cannot deliver).
 *   e) POST-COMMIT delivery fail  -> FAILED + a treasury reconciliation case is
 *      (buy OK, broadcast fails)     opened (CasePort called) — the irreversible side.
 *   f) idempotent saga re-run     -> no double-buy, no double-send.
 *
 * No real network anywhere; everything is deterministic + injected.
 */
import { TransactionSaga, TransactionContext } from '../services/transaction/transaction.saga';
import { BlockchainAddressValidationAdapter } from '../services/transaction/address-validation.adapter';
import { LedgerService, LedgerStore, LedgerEvent } from '../libs/ledger/ledger.service';
import { AuthEngine, AuthRefStore } from '../services/payment/auth-engine.service';
import { PaymentRouter, RouteStore, RouteCandidate } from '../services/payment/payment-router.service';
import { AdyenAdapter } from '../services/payment/gateway/adyen.adapter';
import { HttpClient } from '../services/payment/gateway/payment-gateway.port';
import { ComplianceEngine } from '../services/compliance/compliance-engine.service';
import {
  KycPort, SanctionsPort, WalletScreeningPort, TravelRulePort,
} from '../services/compliance/compliance.ports';
import { CryptoExecEngine } from '../services/crypto-exec/crypto-exec.engine';
import { InMemoryExchange } from '../services/crypto-exec/testing/in-memory-exchange';
import { ChainDeliveryEngine, DeliveryEngineDeps } from '../services/blockchain/delivery.engine';
import {
  InMemoryNode, InMemoryIdempotencyStore, instantClock, InMemoryNodeConfig,
} from '../services/blockchain/testing/in-memory-node';
import { ResolvedProfile } from '@titan/profile-schema';

// ---------- in-memory infra fakes ----------
class MemLedgerStore implements LedgerStore {
  events: LedgerEvent[] = [];
  async lastHash(id: string) { const e = this.events.filter(x => x.aggregateId === id); return e.length ? e[e.length - 1].hash : null; }
  async append(e: LedgerEvent) { this.events.push(e); }
  async list(id: string) { return this.events.filter(x => x.aggregateId === id); }
}
class MemRefStore implements AuthRefStore {
  m = new Map<string, { processor: string; networkRef: string; routeId: string }>();
  async put(id: string, ref: any) { this.m.set(id, ref); }
  async get(id: string) { return this.m.get(id) ?? null; }
}
const routeStore: RouteStore = {
  async candidatesFor(routeId): Promise<RouteCandidate[]> {
    return [{
      route: { routeId, processor: 'adyen', merchantAccount: 'TitanEU', mid: 'mid_1' },
      healthy: true, successRate: 0.99, costBps: 80,
    }];
  },
};

/** Adyen HTTP fake that records every call and can be flipped to decline. */
function makeHttp(opts: { authorised: boolean }) {
  const calls: string[] = [];
  const http: HttpClient = {
    async post(url) {
      calls.push(url);
      if (url.endsWith('/payments')) {
        return opts.authorised
          ? { status: 200, body: { resultCode: 'Authorised', authCode: '4567', pspReference: 'psp_abc' } }
          : { status: 200, body: { resultCode: 'Refused', refusalReason: 'Refused', pspReference: 'psp_dec' } };
      }
      if (url.endsWith('/cancels')) return { status: 200, body: { status: 'received', pspReference: 'psp_void' } };
      return { status: 404, body: {} };
    },
  };
  return { http, calls };
}

// ---------- compliance vendor fakes (all-clear by default) ----------
interface ComplianceVendors { kyc: KycPort; sanctions: SanctionsPort; wallet: WalletScreeningPort; travel: TravelRulePort; }
function vendors(): ComplianceVendors {
  return {
    kyc: { async getStatus(cid) { return { customerId: cid, level: 'FULL_LIVENESS', status: 'VERIFIED' }; } },
    sanctions: { async screenCustomer() { return { hit: false, lists: [] }; } },
    wallet: { async screenAddress() { return { blocked: false, category: 'clean' }; } },
    travel: { async evaluate() { return { required: true, satisfied: true, ref: 'tr_1' }; } },
  };
}

const okRisk = { evaluate: async () => ({ allow: true, score: 10, reasons: [] }) };

// ---------- profile + ctx ----------
function profile(): ResolvedProfile {
  return {
    id: '44444444-4444-4444-4444-444444444444', label: '101.3', family: '101', version: 1,
    signature: 'sig', resolvedFor: 'dev1', etag: 'e1', expiresAt: '2999-01-01T00:00:00.000Z',
    dimensions: {
      processorRoute: 'route_eu_a',
      approvalPolicy: { type: 'OOB_OTP', length: 6, preAuth: true, stepUpTriggers: [] },
      captureMethods: { card: ['EMV'], wallet: ['QR'] },
      kycLevel: 'FULL_LIVENESS',
      assetSet: ['ETH'],
      // checksum NOT enforced so an all-lower address still passes the gate; we
      // exercise the gate's reject path via a chain-MISMATCHED address instead.
      walletValidation: { enforceChecksum: false, screenDestination: true, blockMixers: true },
      riskTier: 'tier_std',
      txCaps: { perTxn: 1_000_000, daily: 3_000_000, currency: 'EUR' },
      settlementRoute: 'settle_eu', compliancePack: 'EU_MiCA_TFR', deliveryStrategy: 'BUY_THEN_SEND',
    },
  };
}

// Deliver ETH to a real, valid EVM mainnet destination on the ethereum chain.
const EVM_DEST = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
// A structurally valid BTC address — on the ethereum chain it is a family mismatch.
const BTC_DEST = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';

function ctx(over: Partial<TransactionContext> = {}): TransactionContext {
  return {
    id: over.id ?? 't_' + Math.random().toString(36).slice(2),
    deviceId: 'dev1', profile: profile(),
    fiatAmount: 1000, fiatCurrency: 'EUR', asset: 'ETH', chain: 'ethereum',
    destWallet: EVM_DEST, state: 'CREATED',
    customerId: 'cust_1', cardToken: 'tok_1', geoCountry: 'DE',
    ...over,
  };
}

// ---------- full REAL-stack harness ----------
interface BuildOpts {
  authorised?: boolean;
  venues: InMemoryExchange[];
  maxSlippageBps?: number;
  node?: InMemoryNodeConfig;
}
function buildSaga(opts: BuildOpts) {
  const ledger = new LedgerService(new MemLedgerStore(), () => '2026-01-01T00:00:00.000Z');
  const { http, calls } = makeHttp({ authorised: opts.authorised ?? true });
  const adapter = new AdyenAdapter(http, 'https://x-checkout/v71', () => 'key');
  const router = new PaymentRouter(routeStore, new Map([['adyen', adapter]]));
  const auth = new AuthEngine(router, new MemRefStore());
  const v = vendors();
  const compliance = new ComplianceEngine(v.kyc, v.sanctions, v.wallet, v.travel, { async open() {} });

  // REAL crypto execution engine over configurable in-memory venues.
  const crypto = new CryptoExecEngine(opts.venues, { maxSlippageBps: opts.maxSlippageBps ?? 100 });

  // REAL chain delivery engine over an in-memory node + instant clock.
  const node = new InMemoryNode(opts.node ?? { confirmationsOverCalls: [0, 6, 12], confirmedAt: 12 });
  const idem = new InMemoryIdempotencyStore();
  const deliveryDeps: DeliveryEngineDeps = {
    nodeFor: () => node,
    idempotency: idem,
    clock: instantClock,
    policy: { maxAttempts: 40, pollIntervalMs: 1, pendingBeforeBump: 3 },
  };
  const delivery = new ChainDeliveryEngine(deliveryDeps);

  const txns = new Map<string, TransactionContext>();
  const repo = { async save(c: TransactionContext) { txns.set(c.id, c); } };
  const cases = { opened: [] as string[], async openTreasuryReconciliation(id: string) { cases.opened.push(id); } };
  const addressGate = new BlockchainAddressValidationAdapter();

  const saga = new TransactionSaga(
    ledger, auth, compliance, okRisk as any, crypto, delivery, cases, repo, addressGate,
  );
  return { saga, calls, node, idem, cases, venues: opts.venues };
}

describe('E2E delivery — the bright line (real saga + real exec + real delivery)', () => {
  it('a) happy path -> COMPLETED, best venue chosen, txid exists, confirmations reached', async () => {
    const a = new InMemoryExchange({ name: 'venueA', price: '2000', feeBps: 100 });   // net 2020
    const b = new InMemoryExchange({ name: 'venueB', price: '2005', feeBps: 10 });    // net ~2007 (best)
    const { saga, calls, node, idem, venues } = buildSaga({ venues: [a, b] });

    const c = ctx({ id: 't_happy' });
    const final = await saga.run(c);

    expect(final).toBe('COMPLETED');
    expect(calls.some(u => u.endsWith('/payments'))).toBe(true);
    expect(calls.some(u => u.endsWith('/cancels'))).toBe(false);  // fiat NEVER voided
    expect(b.placements).toBe(1);                                 // best NET venue chosen
    expect(a.placements).toBe(0);
    expect(venues.reduce((n, v) => n + v.placements, 0)).toBe(1); // exactly one buy
    expect(node.broadcasts.length).toBe(1);                       // one on-chain send
    expect(node.broadcasts[0].amountBaseUnits).toBeTruthy();      // a real amount was broadcast
    const txid = await idem.wasSent('delivery:t_happy');
    expect(txid).toBeTruthy();                                    // a txid was recorded
    expect(node.statusCalls).toBeGreaterThan(0);                  // confirmations were polled
  });

  it('b) slippage breach -> REVERSED, fiat voided, NO on-chain broadcast', async () => {
    // fill executes +150 bps vs quote; tolerance 50 bps -> buy aborts pre-commit.
    const v = new InMemoryExchange({ name: 'slippy', price: '2000', feeBps: 0, fillPrice: '2030' });
    const { saga, calls, node, venues } = buildSaga({ venues: [v], maxSlippageBps: 50 });

    const final = await saga.run(ctx());

    expect(final).toBe('REVERSED');
    expect(calls.some(u => u.endsWith('/cancels'))).toBe(true);   // fiat voided
    expect(node.broadcasts.length).toBe(0);                       // NOTHING broadcast on-chain
    // the buy was ATTEMPTED then rejected on slippage (placement recorded, but no delivery).
    expect(venues[0].placements).toBe(1);
  });

  it('c) all venues down -> REVERSED, no broadcast', async () => {
    const down = new InMemoryExchange({ name: 'down', price: '2000', feeBps: 0, up: false });
    const noWd = new InMemoryExchange({ name: 'noWd', price: '2000', feeBps: 0, withdrawalsEnabled: false });
    const { saga, calls, node } = buildSaga({ venues: [down, noWd] });

    const final = await saga.run(ctx());

    expect(final).toBe('REVERSED');
    expect(calls.some(u => u.endsWith('/cancels'))).toBe(true);   // fiat voided
    expect(node.broadcasts.length).toBe(0);
    expect(down.placements).toBe(0);
    expect(noWd.placements).toBe(0);
  });

  it('d) invalid / chain-mismatched destination -> REVERSED PRE-buy, ZERO exchange orders', async () => {
    const v = new InMemoryExchange({ name: 'v', price: '2000', feeBps: 0 });
    const { saga, calls, node, venues } = buildSaga({ venues: [v] });

    // ethereum chain but a BTC destination address -> pre-commit gate rejects.
    const final = await saga.run(ctx({ destWallet: BTC_DEST }));

    expect(final).toBe('REVERSED');
    expect(calls.some(u => u.endsWith('/cancels'))).toBe(true);   // fiat voided
    expect(venues[0].placements).toBe(0);                         // we NEVER bought crypto
    expect(node.broadcasts.length).toBe(0);                       // and never broadcast
  });

  it('e) POST-COMMIT delivery failure (buy OK, broadcast fails) -> FAILED + treasury case opened', async () => {
    const v = new InMemoryExchange({ name: 'v', price: '2000', feeBps: 0 });
    // node.broadcast throws -> the irreversible side fails AFTER crypto is bought.
    const { saga, calls, cases, venues, node } = buildSaga({
      venues: [v], node: { failBroadcast: 'NODE_REJECTED' },
    });

    const final = await saga.run(ctx());

    expect(final).toBe('FAILED');                                 // not REVERSED — crypto is irreversible
    expect(venues[0].placements).toBe(1);                         // the buy DID happen
    expect(node.broadcasts.length).toBe(0);                       // broadcast rejected
    expect(calls.some(u => u.endsWith('/cancels'))).toBe(false);  // fiat NOT voided (we hold crypto)
    expect(cases.opened.length).toBe(1);                          // treasury reconciliation opened
    expect(cases.opened[0]).toBeTruthy();
  });

  it('f) idempotent saga re-run on the same ctx does not double-buy or double-send', async () => {
    const v = new InMemoryExchange({ name: 'v', price: '2000', feeBps: 0 });
    const { saga, node, venues } = buildSaga({ venues: [v] });
    const c = ctx({ id: 't_idem_e2e' });

    const first = await saga.run(c);
    // Re-run on a FRESH ctx with the SAME id (simulating at-least-once redelivery /
    // crash-retry); the idempotent buy + send must not duplicate side effects.
    const second = await saga.run(ctx({ id: 't_idem_e2e' }));

    expect(first).toBe('COMPLETED');
    expect(second).toBe('COMPLETED');
    expect(venues[0].placements).toBe(1);  // ONE real exchange order across both runs
    expect(node.broadcasts.length).toBe(1); // ONE on-chain broadcast across both runs
  });
});
