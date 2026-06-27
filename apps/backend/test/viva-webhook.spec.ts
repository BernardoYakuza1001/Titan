/**
 * PROJECT TITAN — webhook confirmation: the trust boundary.
 *
 * Covers ConfirmCheckoutPaymentService (independent verification + idempotency)
 * and VivaWebhookController (verification handshake + optional shared-secret gate).
 */
import {
  ConfirmCheckoutPaymentService, WebhookEvent,
} from '../services/viva/confirm-checkout-payment.service';
import { VivaTransactionVerifier, VivaTransactionDetails } from '../services/viva/viva-verify';
import { VivaWebhookController } from '../services/viva/webhook.controller';
import { ConfirmResult } from '../services/viva/confirm-checkout-payment.service';
import { VivaEnvConfig } from '../services/viva/viva.config';
import { MemOrderRepo } from './mem-order-repo.helper';

/** A verifier stub whose getTransaction returns a fixed result. */
function verifierReturning(details: VivaTransactionDetails | null): VivaTransactionVerifier {
  return {
    async getTransaction() { return details; },
    async getWebhookToken() { return 'TOKEN-K'; },
  } as unknown as VivaTransactionVerifier;
}

const baseOrder = {
  orderCode: 'OC1', correlationToken: 'c1', terminalId: 'TERM-1',
  merchantId: 'M', amountMinor: 100, currency: 'EUR',
};
const goodTxn: VivaTransactionDetails = {
  transactionId: 'T', orderCode: 'OC1', statusId: 'F', amountMajor: 1.0, currencyCode: '978',
};
const ev = (over: Partial<WebhookEvent> = {}): WebhookEvent =>
  ({ eventTypeId: 1796, orderCode: 'OC1', transactionId: 'T', ...over });

describe('ConfirmCheckoutPaymentService', () => {
  async function withOrder(verifier: VivaTransactionVerifier) {
    const repo = new MemOrderRepo();
    await repo.create(baseOrder);
    return { repo, svc: new ConfirmCheckoutPaymentService(repo, verifier) };
  }

  it('PAID: 1796 with a verified, matching transaction marks the order paid', async () => {
    const { repo, svc } = await withOrder(verifierReturning(goodTxn));
    expect(await svc.handle(ev())).toBe('PAID');
    const o = await repo.findByOrderCode('OC1');
    expect(o?.status).toBe('PAID');
    expect(o?.vivaTransactionId).toBe('T');
  });

  it('REJECTED: amount mismatch never marks paid', async () => {
    const { repo, svc } = await withOrder(verifierReturning({ ...goodTxn, amountMajor: 5.0 }));
    expect(await svc.handle(ev())).toBe('REJECTED_VERIFICATION');
    expect((await repo.findByOrderCode('OC1'))?.status).toBe('PENDING');
  });

  it('REJECTED: order-code mismatch (txn points at another order) never marks paid', async () => {
    const { repo, svc } = await withOrder(verifierReturning({ ...goodTxn, orderCode: 'OTHER' }));
    expect(await svc.handle(ev())).toBe('REJECTED_VERIFICATION');
    expect((await repo.findByOrderCode('OC1'))?.status).toBe('PENDING');
  });

  it('REJECTED: a spoofed webhook whose transaction does not exist never marks paid', async () => {
    const { repo, svc } = await withOrder(verifierReturning(null));
    expect(await svc.handle(ev())).toBe('REJECTED_VERIFICATION');
    expect((await repo.findByOrderCode('OC1'))?.status).toBe('PENDING');
  });

  it('REJECTED: transaction not in success status (StatusId != F)', async () => {
    const { svc } = await withOrder(verifierReturning({ ...goodTxn, statusId: 'E' }));
    expect(await svc.handle(ev())).toBe('REJECTED_VERIFICATION');
  });

  it('NOTED_FAILURE: a 1798 event leaves the order PENDING (forgeable + retry-after-failure)', async () => {
    const { repo, svc } = await withOrder(verifierReturning(null));
    expect(await svc.handle(ev({ eventTypeId: 1798, transactionId: null }))).toBe('NOTED_FAILURE');
    expect((await repo.findByOrderCode('OC1'))?.status).toBe('PENDING');
  });

  it('a genuine 1796 still confirms AFTER a prior 1798 (Viva allows retry-after-failure)', async () => {
    const { repo, svc } = await withOrder(verifierReturning(goodTxn));
    expect(await svc.handle(ev({ eventTypeId: 1798, transactionId: null }))).toBe('NOTED_FAILURE');
    expect(await svc.handle(ev())).toBe('PAID');
    expect((await repo.findByOrderCode('OC1'))?.status).toBe('PAID');
  });

  it('REJECTED: a transaction in a DIFFERENT currency never marks paid', async () => {
    const { repo, svc } = await withOrder(verifierReturning({ ...goodTxn, currencyCode: '840' })); // USD vs EUR order
    expect(await svc.handle(ev())).toBe('REJECTED_VERIFICATION');
    expect((await repo.findByOrderCode('OC1'))?.status).toBe('PENDING');
  });

  it('PAID: a zero-decimal currency (JPY) confirms with exponent-correct scaling (regression for *100 bug)', async () => {
    const repo = new MemOrderRepo();
    await repo.create({ orderCode: 'OCJ', correlationToken: 'cj', terminalId: 'TERM-1', merchantId: 'M', amountMinor: 1000, currency: 'JPY' });
    const svc = new ConfirmCheckoutPaymentService(
      repo, verifierReturning({ transactionId: 'T', orderCode: 'OCJ', statusId: 'F', amountMajor: 1000, currencyCode: '392' }),
    );
    expect(await svc.handle({ eventTypeId: 1796, orderCode: 'OCJ', transactionId: 'T' })).toBe('PAID');
    expect((await repo.findByOrderCode('OCJ'))?.status).toBe('PAID');
  });

  it('IGNORED_UNKNOWN_ORDER: an event for an order we never created', async () => {
    const repo = new MemOrderRepo();
    const svc = new ConfirmCheckoutPaymentService(repo, verifierReturning(goodTxn));
    expect(await svc.handle(ev({ orderCode: 'NOPE' }))).toBe('IGNORED_UNKNOWN_ORDER');
  });

  it('IGNORED_ALREADY_FINAL: a duplicate 1796 after PAID is a no-op (idempotent)', async () => {
    const { svc } = await withOrder(verifierReturning(goodTxn));
    expect(await svc.handle(ev())).toBe('PAID');
    expect(await svc.handle(ev())).toBe('IGNORED_ALREADY_FINAL');
  });

  it('IGNORED_EVENT: an unrelated event type is ignored', async () => {
    const { svc } = await withOrder(verifierReturning(goodTxn));
    expect(await svc.handle(ev({ eventTypeId: 9999 }))).toBe('IGNORED_EVENT');
  });
});

describe('VivaWebhookController', () => {
  function makeCfg(over: Partial<VivaEnvConfig> = {}): VivaEnvConfig {
    return { webhookSecret: '', webhookToken: '', wwwBaseUrl: 'https://www.vivapayments.com', ...over } as VivaEnvConfig;
  }
  function spyConfirm() {
    const calls: WebhookEvent[] = [];
    const svc = {
      async handle(e: WebhookEvent) { calls.push(e); return 'PAID' as ConfirmResult; },
    } as unknown as ConfirmCheckoutPaymentService;
    return { svc, calls };
  }

  it('GET returns the verification { Key }', async () => {
    const ctrl = new VivaWebhookController(verifierReturning(null), spyConfirm().svc, makeCfg());
    expect(await ctrl.verify()).toEqual({ Key: 'TOKEN-K' });
  });

  it('POST forwards a parsed event to confirm when the gate is disabled', async () => {
    const { svc, calls } = spyConfirm();
    const ctrl = new VivaWebhookController(verifierReturning(null), svc, makeCfg());
    const res = await ctrl.event(undefined, { EventTypeId: 1796, EventData: { OrderCode: 555, TransactionId: 'TX' } });
    expect(res).toEqual({ ok: true, result: 'PAID' });
    expect(calls[0]).toEqual({ eventTypeId: 1796, orderCode: '555', transactionId: 'TX' });
  });

  it('POST with the wrong shared secret does NOT call confirm (gate)', async () => {
    const { svc, calls } = spyConfirm();
    const ctrl = new VivaWebhookController(verifierReturning(null), svc, makeCfg({ webhookSecret: 's3cret' }));
    const res = await ctrl.event('wrong', { EventTypeId: 1796, EventData: { OrderCode: 1, TransactionId: 'T' } });
    expect(res.result).toBe('IGNORED_GATE');
    expect(calls).toHaveLength(0);
  });

  it('POST with the correct shared secret passes the gate', async () => {
    const { svc, calls } = spyConfirm();
    const ctrl = new VivaWebhookController(verifierReturning(null), svc, makeCfg({ webhookSecret: 's3cret' }));
    await ctrl.event('s3cret', { EventTypeId: 1796, EventData: { OrderCode: 1, TransactionId: 'T' } });
    expect(calls).toHaveLength(1);
  });
});
