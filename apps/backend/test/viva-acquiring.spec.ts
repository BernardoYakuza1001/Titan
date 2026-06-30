/**
 * PROJECT TITAN — Viva fiat acquiring: error map + adapter + use-case + controller.
 */
import { mapVivaResponse } from '../services/viva/error-map';
import { VivaWalletAcquiringAdapter, HttpClient } from '../services/viva/viva.adapter';
import { AuthHeaderProvider } from '../services/viva/viva-auth';
import { ProcessMotoPaymentService } from '../services/viva/process-moto-payment.service';
import { TerminalHistoryService } from '../services/viva/terminal-history.service';
import { PaymentController, CreatePaymentDto } from '../services/viva/payment.controller';
import { InMemoryLedgerRepository } from '../services/viva/testing/in-memory-ledger.repository';
import { AcquiringGateway } from '../services/viva/ports';
import { PaymentIntent, ChargeOutcome, DuplicateCorrelationError } from '../services/viva/domain';

const intent = (over: Partial<PaymentIntent> = {}): PaymentIntent => ({
  correlationToken: 'corr-0001',
  terminalId: 'TERM-1',
  merchantId: 'MERCH-1',
  amountMinor: 12345,
  currency: 'EUR',
  paymentToken: 'chargeTok_abc',
  maskedPan: '411111****1111',
  cardBrand: 'VISA',
  ...over,
});

// ---------------- error map ----------------
describe('mapVivaResponse', () => {
  it('200 StatusId F -> approved with ids + auth code', () => {
    const o = mapVivaResponse({ status: 200, body: { StatusId: 'F', TransactionId: 'vt_1', OrderCode: 175, RetrievalReferenceNumber: 'auth9' } });
    expect(o.approved).toBe(true);
    expect(o.vivaTransactionId).toBe('vt_1');
    expect(o.vivaOrderCode).toBe('175');
    expect(o.authorizationCode).toBe('auth9');
  });
  it('200 declined with "Insufficient funds" -> INSUFFICIENT_FUNDS', () => {
    const o = mapVivaResponse({ status: 200, body: { StatusId: 'E', ErrorText: 'Insufficient funds', ErrorCode: '51', TransactionId: 'vt_2' } });
    expect(o.approved).toBe(false);
    expect(o.error?.code).toBe('INSUFFICIENT_FUNDS');
    expect(o.vivaTransactionId).toBe('vt_2');
  });
  it('400 expired card -> EXPIRED_CARD', () => {
    expect(mapVivaResponse({ status: 400, body: { ErrorText: 'Expired Card' } }).error?.code).toBe('EXPIRED_CARD');
  });
  it('401 -> CONFIGURATION_ERROR (not retriable)', () => {
    const o = mapVivaResponse({ status: 401, body: {} });
    expect(o.error?.code).toBe('CONFIGURATION_ERROR');
    expect(o.error?.retriable).toBe(false);
  });
  it('504 -> GATEWAY_TIMEOUT (retriable)', () => {
    const o = mapVivaResponse({ status: 504, body: {} });
    expect(o.error?.code).toBe('GATEWAY_TIMEOUT');
    expect(o.error?.retriable).toBe(true);
  });
  it('500 -> GATEWAY_ERROR (retriable)', () => {
    expect(mapVivaResponse({ status: 500, body: {} }).error?.code).toBe('GATEWAY_ERROR');
  });
});

// ---------------- adapter ----------------
function fakeHttp(res: any, opts: { throws?: boolean } = {}): { http: HttpClient; calls: any[] } {
  const calls: any[] = [];
  const http: HttpClient = {
    async post(url, body, headers) {
      calls.push({ url, body, headers });
      if (opts.throws) throw new Error('socket hang up');
      return res;
    },
  };
  return { http, calls };
}
const auth: AuthHeaderProvider = { async authHeader() { return 'Bearer oauth_xyz'; } };
const cfg = { baseUrl: 'https://demo-api.viva.com', transactionsPath: '/checkout/v2/transactions', sourceCode: 'Default' };

describe('VivaWalletAcquiringAdapter', () => {
  it('charges the token and maps a success', async () => {
    const { http, calls } = fakeHttp({ status: 200, body: { StatusId: 'F', TransactionId: 'vt', OrderCode: 9, RetrievalReferenceNumber: 'a1' } });
    const out = await new VivaWalletAcquiringAdapter(http, auth, cfg).charge(intent());
    expect(out.approved).toBe(true);
    // sends minor units + the chargeToken + idempotency key; never a PAN
    expect(calls[0].body.amount).toBe(12345);
    expect(calls[0].body.chargeToken).toBe('chargeTok_abc');
    expect(calls[0].body.currencyCode).toBe(978);
    expect(calls[0].headers['Idempotency-Key']).toBe('corr-0001');
    expect(JSON.stringify(calls[0])).not.toContain('411111111111'); // no full PAN anywhere
  });
  it('charges the MOTO source when intent.moto and a MOTO source is configured', async () => {
    const { http, calls } = fakeHttp({ status: 200, body: { StatusId: 'F' } });
    await new VivaWalletAcquiringAdapter(http, auth, { ...cfg, motoSourceCode: '2024' }).charge(intent({ moto: true }));
    expect(calls[0].body.sourceCode).toBe('2024');
  });
  it('falls back to the e-commerce source for MOTO when none configured', async () => {
    const { http, calls } = fakeHttp({ status: 200, body: { StatusId: 'F' } });
    await new VivaWalletAcquiringAdapter(http, auth, cfg).charge(intent({ moto: true }));
    expect(calls[0].body.sourceCode).toBe('Default');
  });
  it('uses the e-commerce source by default (no moto)', async () => {
    const { http, calls } = fakeHttp({ status: 200, body: { StatusId: 'F' } });
    await new VivaWalletAcquiringAdapter(http, auth, { ...cfg, motoSourceCode: '2024' }).charge(intent());
    expect(calls[0].body.sourceCode).toBe('Default');
  });

  it('maps a decline body to a domain error', async () => {
    const { http } = fakeHttp({ status: 200, body: { StatusId: 'E', ErrorText: 'Do not honor', ErrorCode: '05' } });
    expect((await new VivaWalletAcquiringAdapter(http, auth, cfg).charge(intent())).error?.code).toBe('DO_NOT_HONOR');
  });
  it('a thrown HTTP call -> GATEWAY_TIMEOUT', async () => {
    const { http } = fakeHttp({}, { throws: true });
    expect((await new VivaWalletAcquiringAdapter(http, auth, cfg).charge(intent())).error?.code).toBe('GATEWAY_TIMEOUT');
  });
  it('unsupported currency -> INVALID_AMOUNT, no HTTP call', async () => {
    const { http, calls } = fakeHttp({ status: 200, body: { StatusId: 'F' } });
    const out = await new VivaWalletAcquiringAdapter(http, auth, cfg).charge(intent({ currency: 'XYZ' }));
    expect(out.error?.code).toBe('INVALID_AMOUNT');
    expect(calls).toHaveLength(0);
  });
});

// ---------------- use-case ----------------
class FakeGateway implements AcquiringGateway {
  calls = 0;
  constructor(private readonly outcome: ChargeOutcome | (() => Promise<ChargeOutcome>)) {}
  async charge(): Promise<ChargeOutcome> {
    this.calls++;
    return typeof this.outcome === 'function' ? this.outcome() : this.outcome;
  }
}

describe('ProcessMotoPaymentService', () => {
  it('approved -> ledger FIAT_APPROVED with auth code + viva ids', async () => {
    const gw = new FakeGateway({ approved: true, vivaTransactionId: 'vt', vivaOrderCode: '7', authorizationCode: 'A1' });
    const rec = await new ProcessMotoPaymentService(gw, new InMemoryLedgerRepository()).process(intent());
    expect(rec.status).toBe('FIAT_APPROVED');
    expect(rec.authorizationCode).toBe('A1');
    expect(rec.vivaTransactionId).toBe('vt');
    expect(rec.errorLog).toBeNull();
  });
  it('declined -> FIAT_DECLINED with error_log', async () => {
    const gw = new FakeGateway({ approved: false, error: { code: 'INSUFFICIENT_FUNDS', message: 'no funds', retriable: false } });
    const rec = await new ProcessMotoPaymentService(gw, new InMemoryLedgerRepository()).process(intent());
    expect(rec.status).toBe('FIAT_DECLINED');
    expect(rec.errorLog).toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
  });
  it('idempotent: same correlation_token charges ONCE', async () => {
    const gw = new FakeGateway({ approved: true });
    const repo = new InMemoryLedgerRepository();
    const svc = new ProcessMotoPaymentService(gw, repo);
    const a = await svc.process(intent());
    const b = await svc.process(intent());
    expect(a.id).toBe(b.id);
    expect(gw.calls).toBe(1);          // never double-charged
  });
  it('gateway throws -> FIAT_DECLINED GATEWAY_ERROR (fiat not lost)', async () => {
    const gw = new FakeGateway(async () => { throw new Error('boom'); });
    const rec = await new ProcessMotoPaymentService(gw, new InMemoryLedgerRepository()).process(intent());
    expect(rec.status).toBe('FIAT_DECLINED');
    expect(rec.errorLog).toMatchObject({ code: 'GATEWAY_ERROR' });
  });
  it('concurrent-duplicate race: create-conflict returns the winner, no charge', async () => {
    const winner = { id: 'fiat_win', status: 'FIAT_APPROVED' } as any;
    const repo: any = {
      findByCorrelationToken: jest.fn()
        .mockResolvedValueOnce(null)     // fast path misses
        .mockResolvedValueOnce(winner),  // after conflict, winner exists
      create: jest.fn().mockRejectedValue(new DuplicateCorrelationError('corr-0001')),
    };
    const gw = new FakeGateway({ approved: true });
    const rec = await new ProcessMotoPaymentService(gw, repo).process(intent());
    expect(rec).toBe(winner);
    expect(gw.calls).toBe(0);
  });
});

// ---------------- history + controller ----------------
describe('TerminalHistoryService + PaymentController', () => {
  it('returns only the calling terminal rows, newest first', async () => {
    const repo = new InMemoryLedgerRepository();
    const gw = new FakeGateway({ approved: true });
    const svc = new ProcessMotoPaymentService(gw, repo);
    await svc.process(intent({ correlationToken: 'a1', terminalId: 'TERM-1' }));
    await svc.process(intent({ correlationToken: 'a2', terminalId: 'TERM-1' }));
    await svc.process(intent({ correlationToken: 'b1', terminalId: 'TERM-2' }));

    const history = new TerminalHistoryService(repo);
    const rows = await history.byTerminal('TERM-1', 50, 0);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.terminalId === 'TERM-1')).toBe(true);
    expect(rows[0].correlationToken).toBe('a2'); // newest first
  });

  it('controller scopes by authenticated terminal id and rejects when missing', async () => {
    const repo = new InMemoryLedgerRepository();
    const process = new ProcessMotoPaymentService(new FakeGateway({ approved: true }), repo);
    const history = new TerminalHistoryService(repo);
    const ctrl = new PaymentController(process, history);

    const dto: CreatePaymentDto = {
      correlationToken: 'ctrl-001', merchantId: 'MERCH-1', amountMinor: 500,
      currency: 'eur', paymentToken: 'tok', maskedPan: '411111****1111', cardBrand: 'VISA',
    };
    const rec = await ctrl.createPayment('TERM-9', dto);
    expect(rec.terminalId).toBe('TERM-9');     // taken from header identity, not the body
    expect(rec.status).toBe('FIAT_APPROVED');

    await expect(ctrl.createPayment(undefined, dto)).rejects.toThrow();   // no terminal identity
    const rows = await ctrl.terminalHistory('TERM-9');
    expect(rows).toHaveLength(1);
  });
});
