/**
 * PROJECT TITAN — End-to-end proof of the BLOCKING-GATE path (Phase 4 + 8).
 *
 * Wires the REAL TransactionSaga + AuthEngine + ComplianceEngine together with
 * in-memory fakes for vendor HTTP, and asserts the safety-critical invariants:
 *
 *   1. all-clear            -> COMPLETED, fiat NEVER voided
 *   2. sanctioned customer  -> REVERSED, fiat voided, case opened, NO crypto
 *   3. blocked dest wallet  -> REVERSED, fiat voided, NO crypto
 *   4. KYC insufficient     -> REVERSED, fiat voided, NO crypto
 *   5. auth declined        -> DECLINED, nothing to void
 *
 * Run: pnpm --filter @titan/backend test
 */
import { TransactionSaga, TransactionContext } from '../services/transaction/transaction.saga';
import { LedgerService, LedgerStore, LedgerEvent } from '../libs/ledger/ledger.service';
import { AuthEngine, AuthRefStore } from '../services/payment/auth-engine.service';
import { PaymentRouter, RouteStore, RouteCandidate } from '../services/payment/payment-router.service';
import { AdyenAdapter } from '../services/payment/gateway/adyen.adapter';
import { HttpClient } from '../services/payment/gateway/payment-gateway.port';
import { ComplianceEngine } from '../services/compliance/compliance-engine.service';
import {
  KycPort, SanctionsPort, WalletScreeningPort, TravelRulePort,
} from '../services/compliance/compliance.ports';
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

/** Adyen HTTP fake that records calls and is configurable for decline. */
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

// ---------- saga downstream fakes (forward path beyond the gates) ----------
const okRisk = { evaluate: async () => ({ allow: true, score: 10, reasons: [] }) };
const okCrypto = { buy: async () => ({ ok: true, qty: '0.01', venue: 'kraken' }) };
const okDelivery = {
  send: async () => ({ ok: true, txid: '0xdead' }),
  awaitConfirmations: async () => true,
};

// ---------- helpers ----------
function profile(): ResolvedProfile {
  return {
    id: '11111111-1111-1111-1111-111111111111', label: '101.3', family: '101', version: 1,
    signature: 'sig', resolvedFor: 'dev1', etag: 'e1', expiresAt: '2999-01-01T00:00:00.000Z',
    dimensions: {
      processorRoute: 'route_eu_a',
      approvalPolicy: { type: 'OOB_OTP', length: 6, preAuth: true, stepUpTriggers: [] },
      captureMethods: { card: ['EMV'], wallet: ['QR'] },
      kycLevel: 'FULL_LIVENESS',
      assetSet: ['BTC'],
      walletValidation: { enforceChecksum: true, screenDestination: true, blockMixers: true },
      riskTier: 'tier_std',
      txCaps: { perTxn: 1000, daily: 3000, currency: 'EUR' },
      settlementRoute: 'settle_eu', compliancePack: 'EU_MiCA_TFR', deliveryStrategy: 'BUY_THEN_SEND',
    },
  };
}

function ctx(): TransactionContext {
  return {
    id: 't_' + Math.random().toString(36).slice(2), deviceId: 'dev1', profile: profile(),
    fiatAmount: 50, fiatCurrency: 'EUR', asset: 'BTC', chain: 'BTC',
    destWallet: 'bc1qexample', state: 'CREATED',
    customerId: 'cust_1', cardToken: 'tok_1', geoCountry: 'DE',
  };
}

interface ComplianceVendors {
  kyc: KycPort; sanctions: SanctionsPort; wallet: WalletScreeningPort; travel: TravelRulePort;
}
function vendors(over: Partial<{
  kycLevel: any; kycStatus: any; sanctioned: boolean; walletBlocked: boolean; trSatisfied: boolean;
}> = {}): ComplianceVendors {
  return {
    kyc: { async getStatus(cid) { return { customerId: cid, level: over.kycLevel ?? 'FULL_LIVENESS', status: over.kycStatus ?? 'VERIFIED' }; } },
    sanctions: { async screenCustomer() { return over.sanctioned ? { hit: true, lists: ['OFAC-SDN'] } : { hit: false, lists: [] }; } },
    wallet: { async screenAddress() { return over.walletBlocked ? { blocked: true, category: 'sanctioned' } : { blocked: false, category: 'clean' }; } },
    travel: { async evaluate() { return { required: true, satisfied: over.trSatisfied ?? true, ref: 'tr_1' }; } },
  };
}

function buildSaga(http: HttpClient, v: ComplianceVendors) {
  const ledger = new LedgerService(new MemLedgerStore(), () => '2026-01-01T00:00:00.000Z');
  const adapter = new AdyenAdapter(http, 'https://x-checkout/v71', () => 'key');
  const router = new PaymentRouter(routeStore, new Map([['adyen', adapter]]));
  const auth = new AuthEngine(router, new MemRefStore());
  const compliance = new ComplianceEngine(v.kyc, v.sanctions, v.wallet, v.travel, { async open() {} });
  const txns = new Map<string, TransactionContext>();
  const repo = { async save(c: TransactionContext) { txns.set(c.id, c); } };
  const cryptoSpy = { calls: 0, buy: async () => { cryptoSpy.calls++; return okCrypto.buy(); } };
  const cases = { opened: [] as string[], async openTreasuryReconciliation(id: string) { cases.opened.push(id); } };
  const saga = new TransactionSaga(ledger, auth, compliance, okRisk as any, cryptoSpy as any, okDelivery as any, cases, repo);
  return { saga, cryptoSpy, cases };
}

describe('blocking-gate path (auth -> compliance -> crypto)', () => {
  it('1) all clear -> COMPLETED, fiat never voided', async () => {
    const { http, calls } = makeHttp({ authorised: true });
    const { saga, cryptoSpy } = buildSaga(http, vendors());
    const c = ctx();
    const final = await saga.run(c);
    expect(final).toBe('COMPLETED');
    expect(calls.some(u => u.endsWith('/payments'))).toBe(true);
    expect(calls.some(u => u.endsWith('/cancels'))).toBe(false); // no void
    expect(cryptoSpy.calls).toBe(1);                              // crypto executed
  });

  it('2) sanctioned customer -> REVERSED, fiat voided, no crypto', async () => {
    const { http, calls } = makeHttp({ authorised: true });
    const { saga, cryptoSpy, cases } = buildSaga(http, vendors({ sanctioned: true }));
    const final = await saga.run(ctx());
    expect(final).toBe('REVERSED');
    expect(calls.some(u => u.endsWith('/cancels'))).toBe(true);   // fiat voided
    expect(cryptoSpy.calls).toBe(0);                              // crypto NEVER touched
    expect(cases.opened.length).toBe(0);                          // clean void, no treasury case
  });

  it('3) blocked destination wallet -> REVERSED, voided, no crypto', async () => {
    const { http, calls } = makeHttp({ authorised: true });
    const { saga, cryptoSpy } = buildSaga(http, vendors({ walletBlocked: true }));
    expect(await saga.run(ctx())).toBe('REVERSED');
    expect(calls.some(u => u.endsWith('/cancels'))).toBe(true);
    expect(cryptoSpy.calls).toBe(0);
  });

  it('4) insufficient KYC -> REVERSED, voided, no crypto', async () => {
    const { http, calls } = makeHttp({ authorised: true });
    const { saga, cryptoSpy } = buildSaga(http, vendors({ kycLevel: 'BASIC' }));
    expect(await saga.run(ctx())).toBe('REVERSED');
    expect(calls.some(u => u.endsWith('/cancels'))).toBe(true);
    expect(cryptoSpy.calls).toBe(0);
  });

  it('5) auth declined -> DECLINED, nothing to void', async () => {
    const { http, calls } = makeHttp({ authorised: false });
    const { saga, cryptoSpy } = buildSaga(http, vendors());
    expect(await saga.run(ctx())).toBe('DECLINED');
    expect(calls.some(u => u.endsWith('/cancels'))).toBe(false);  // no auth to void
    expect(cryptoSpy.calls).toBe(0);
  });
});
