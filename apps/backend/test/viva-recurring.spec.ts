/**
 * PROJECT TITAN — Recurring / merchant-initiated (no-OTP) charge:
 * gateway (Basic-auth MIT call) + use-case (idempotency) + controller (scoping).
 */
import { ForbiddenException } from '@nestjs/common';
import { VivaRecurringGateway } from '../services/viva/viva-recurring.gateway';
import { ProcessRecurringChargeService, RecurringChargeInput } from '../services/viva/process-recurring-charge.service';
import { RecurringController, CreateRecurringChargeDto } from '../services/viva/recurring.controller';
import { HttpClient } from '../services/viva/viva.adapter';
import { BasicAuthProvider } from '../services/viva/viva-auth';
import { DuplicateCorrelationError } from '../services/viva/domain';
import {
  RecurringRepository, RecurringChargeRecord, NewRecurringCharge, RecurringStatusPatch,
} from '../services/viva/recurring.store';

function http(res: any, opts: { throws?: boolean } = {}) {
  const calls: any[] = [];
  const h: HttpClient = { async post(u, b, hd) { calls.push({ u, b, hd }); if (opts.throws) throw new Error('net'); return res; } };
  return { h, calls };
}

const auth = new BasicAuthProvider('MID', 'KEY');
const BASIC = 'Basic ' + Buffer.from('MID:KEY').toString('base64');
const cfg = { wwwBaseUrl: 'https://www.vivapayments.com', sourceCode: '1937' };
const req = { initialTransactionId: 'TX-INIT', amountMinor: 500, currency: 'EUR', correlationToken: 'corr-1', customerTrns: 'Sub' };

describe('VivaRecurringGateway', () => {
  it('charges the initial transaction over Basic auth and maps success (no 3DS path)', async () => {
    const { h, calls } = http({ status: 200, body: { StatusId: 'F', TransactionId: 'vt_2' } });
    const out = await new VivaRecurringGateway(h, auth, cfg).charge(req);
    expect(out.approved).toBe(true);
    expect(out.vivaTransactionId).toBe('vt_2');
    expect(calls[0].u).toBe('https://www.vivapayments.com/api/transactions/TX-INIT');
    expect(calls[0].hd.Authorization).toBe(BASIC);
    expect(calls[0].hd['Idempotency-Key']).toBe('corr-1');
    expect(calls[0].b.amount).toBe(500);
    expect(calls[0].b.currencyCode).toBe(978);
    expect(calls[0].b.merchantTrns).toBe('corr-1');
    expect(calls[0].b.sourceCode).toBe('1937');
  });
  it('maps a decline body to a domain error', async () => {
    const { h } = http({ status: 200, body: { StatusId: 'E', ErrorText: 'Do not honor', ErrorCode: '05' } });
    expect((await new VivaRecurringGateway(h, auth, cfg).charge(req)).error?.code).toBe('DO_NOT_HONOR');
  });
  it('unsupported currency -> INVALID_AMOUNT, no HTTP call', async () => {
    const { h, calls } = http({ status: 200, body: {} });
    const out = await new VivaRecurringGateway(h, auth, cfg).charge({ ...req, currency: 'ZZZ' });
    expect(out.error?.code).toBe('INVALID_AMOUNT');
    expect(calls).toHaveLength(0);
  });
  it('a thrown HTTP call -> GATEWAY_TIMEOUT', async () => {
    const { h } = http({}, { throws: true });
    expect((await new VivaRecurringGateway(h, auth, cfg).charge(req)).error?.code).toBe('GATEWAY_TIMEOUT');
  });
});

// in-memory recurring repo
class MemRecurringRepo implements RecurringRepository {
  private readonly byToken = new Map<string, RecurringChargeRecord>();
  private seq = 0;
  async create(c: NewRecurringCharge): Promise<RecurringChargeRecord> {
    if (this.byToken.has(c.correlationToken)) throw new DuplicateCorrelationError(c.correlationToken);
    const rec: RecurringChargeRecord = {
      id: 'r' + (++this.seq), ...c, vivaTransactionId: null, errorLog: null,
      status: 'RECURRING_CREATED', createdAt: 't', updatedAt: 't',
    };
    this.byToken.set(c.correlationToken, rec);
    return { ...rec };
  }
  async findByCorrelationToken(t: string) { const r = this.byToken.get(t); return r ? { ...r } : null; }
  async updateStatus(id: string, patch: RecurringStatusPatch) {
    for (const r of this.byToken.values()) {
      if (r.id === id) {
        r.status = patch.status;
        if (patch.vivaTransactionId != null) r.vivaTransactionId = patch.vivaTransactionId;
        if (patch.errorLog != null) r.errorLog = patch.errorLog;
        return { ...r };
      }
    }
    throw new Error('no such');
  }
}

const input: RecurringChargeInput = {
  correlationToken: 'c1', terminalId: 'TERM-1', merchantId: 'M', initialTransactionId: 'TX', amountMinor: 500, currency: 'EUR',
};
const gw = (outcome: any) => ({ async charge() { return outcome; } }) as unknown as VivaRecurringGateway;

describe('ProcessRecurringChargeService', () => {
  it('APPROVED on success, records the MIT transaction id', async () => {
    const repo = new MemRecurringRepo();
    const rec = await new ProcessRecurringChargeService(gw({ approved: true, vivaTransactionId: 'vt' }), repo).process(input);
    expect(rec.status).toBe('RECURRING_APPROVED');
    expect(rec.vivaTransactionId).toBe('vt');
  });
  it('DECLINED on failure with an error log (no throw)', async () => {
    const repo = new MemRecurringRepo();
    const rec = await new ProcessRecurringChargeService(gw({ approved: false, error: { code: 'DO_NOT_HONOR', message: 'x', retriable: false } }), repo).process(input);
    expect(rec.status).toBe('RECURRING_DECLINED');
    expect(rec.errorLog?.code).toBe('DO_NOT_HONOR');
  });
  it('idempotent: a retried correlation token returns the original and charges only once', async () => {
    const repo = new MemRecurringRepo();
    let charges = 0;
    const gateway = { async charge() { charges++; return { approved: true, vivaTransactionId: 'vt' }; } } as unknown as VivaRecurringGateway;
    const svc = new ProcessRecurringChargeService(gateway, repo);
    await svc.process(input);
    const r2 = await svc.process(input);
    expect(charges).toBe(1);
    expect(r2.status).toBe('RECURRING_APPROVED');
  });
});

describe('RecurringController', () => {
  it('rejects when terminal identity is missing', async () => {
    const svc = { async process() { return {} as any; } } as unknown as ProcessRecurringChargeService;
    const dto = { correlationToken: 'c1xxxxxx', merchantId: 'M', initialTransactionId: 'TX', amountMinor: 1, currency: 'EUR' } as CreateRecurringChargeDto;
    await expect(new RecurringController(svc).charge(undefined, dto)).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('passes the authoritative terminal id and upper-cased currency', async () => {
    let captured: RecurringChargeInput | undefined;
    const svc = { async process(i: RecurringChargeInput) { captured = i; return { status: 'RECURRING_APPROVED' } as any; } } as unknown as ProcessRecurringChargeService;
    const dto = { correlationToken: 'c1xxxxxx', merchantId: 'M', initialTransactionId: 'TX', amountMinor: 500, currency: 'eur' } as CreateRecurringChargeDto;
    await new RecurringController(svc).charge('TERM-9', dto);
    expect(captured?.terminalId).toBe('TERM-9');
    expect(captured?.currency).toBe('EUR');
  });
});
