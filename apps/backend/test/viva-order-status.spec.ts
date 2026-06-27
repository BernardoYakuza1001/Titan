/**
 * PROJECT TITAN — order status query: terminal-scoped (no cross-terminal leak)
 * AND self-confirming via the Viva pull path (works without a webhook).
 */
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { GetOrderStatusService } from '../services/viva/get-order-status.service';
import { OrderStatusController } from '../services/viva/order-status.controller';
import { VivaTransactionVerifier, VivaTransactionDetails } from '../services/viva/viva-verify';
import { MemOrderRepo } from './mem-order-repo.helper';

const order = (terminalId: string) => ({
  orderCode: 'OC1', correlationToken: 'c1', terminalId, merchantId: 'M', amountMinor: 100, currency: 'EUR',
});

/** Verifier stub whose pull (listTransactionsByOrder) returns a fixed list. */
function verifier(txns: VivaTransactionDetails[] = []): VivaTransactionVerifier {
  return { async listTransactionsByOrder() { return txns; } } as unknown as VivaTransactionVerifier;
}
const confirmingTxn: VivaTransactionDetails = {
  transactionId: 'T', orderCode: 'OC1', statusId: 'F', amountMajor: 1.0, currencyCode: '978',
};

describe('GetOrderStatusService', () => {
  it('returns PENDING when Viva has no confirming transaction yet', async () => {
    const repo = new MemOrderRepo();
    await repo.create(order('TERM-1'));
    const v = await new GetOrderStatusService(repo, verifier([])).byOrderCodeForTerminal('OC1', 'TERM-1');
    expect(v?.status).toBe('PENDING');
    expect(v?.amountMinor).toBe(100);
  });

  it('self-confirms via the pull path: a matching Viva transaction flips it to PAID', async () => {
    const repo = new MemOrderRepo();
    await repo.create(order('TERM-1'));
    const v = await new GetOrderStatusService(repo, verifier([confirmingTxn])).byOrderCodeForTerminal('OC1', 'TERM-1');
    expect(v?.status).toBe('PAID');
    expect(v?.vivaTransactionId).toBe('T');
    expect((await repo.findByOrderCode('OC1'))?.status).toBe('PAID');
  });

  it('does NOT confirm on a non-matching transaction (wrong amount)', async () => {
    const repo = new MemOrderRepo();
    await repo.create(order('TERM-1'));
    const v = await new GetOrderStatusService(repo, verifier([{ ...confirmingTxn, amountMajor: 5.0 }]))
      .byOrderCodeForTerminal('OC1', 'TERM-1');
    expect(v?.status).toBe('PENDING');
  });

  it('returns null for a different terminal (no cross-terminal information leak)', async () => {
    const repo = new MemOrderRepo();
    await repo.create(order('TERM-1'));
    expect(await new GetOrderStatusService(repo, verifier([confirmingTxn])).byOrderCodeForTerminal('OC1', 'TERM-2')).toBeNull();
  });
});

describe('OrderStatusController', () => {
  const svc = (repo: MemOrderRepo, txns: VivaTransactionDetails[] = []) =>
    new GetOrderStatusService(repo, verifier(txns));

  it('404s when the order is not found / not owned', async () => {
    const ctrl = new OrderStatusController(svc(new MemOrderRepo()));
    await expect(ctrl.status('TERM-1', 'NOPE')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects when terminal identity is missing', async () => {
    const ctrl = new OrderStatusController(svc(new MemOrderRepo()));
    await expect(ctrl.status(undefined, 'OC1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('returns the view for the owning terminal', async () => {
    const repo = new MemOrderRepo();
    await repo.create(order('TERM-1'));
    const res = await new OrderStatusController(svc(repo)).status('TERM-1', 'OC1');
    expect(res.orderCode).toBe('OC1');
    expect(res.status).toBe('PENDING');
  });
});
