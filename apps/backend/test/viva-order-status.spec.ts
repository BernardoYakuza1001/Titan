/**
 * PROJECT TITAN — order status query: terminal-scoped (no cross-terminal leak).
 */
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { GetOrderStatusService } from '../services/viva/get-order-status.service';
import { OrderStatusController } from '../services/viva/order-status.controller';
import { MemOrderRepo } from './mem-order-repo.helper';

const order = (terminalId: string) => ({
  orderCode: 'OC1', correlationToken: 'c1', terminalId, merchantId: 'M', amountMinor: 100, currency: 'EUR',
});

describe('GetOrderStatusService', () => {
  it('returns the status for the owning terminal', async () => {
    const repo = new MemOrderRepo();
    await repo.create(order('TERM-1'));
    const v = await new GetOrderStatusService(repo).byOrderCodeForTerminal('OC1', 'TERM-1');
    expect(v?.status).toBe('PENDING');
    expect(v?.amountMinor).toBe(100);
  });

  it('returns null for a different terminal (no cross-terminal information leak)', async () => {
    const repo = new MemOrderRepo();
    await repo.create(order('TERM-1'));
    expect(await new GetOrderStatusService(repo).byOrderCodeForTerminal('OC1', 'TERM-2')).toBeNull();
  });
});

describe('OrderStatusController', () => {
  it('404s when the order is not found / not owned', async () => {
    const ctrl = new OrderStatusController(new GetOrderStatusService(new MemOrderRepo()));
    await expect(ctrl.status('TERM-1', 'NOPE')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects when terminal identity is missing', async () => {
    const ctrl = new OrderStatusController(new GetOrderStatusService(new MemOrderRepo()));
    await expect(ctrl.status(undefined, 'OC1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('returns the view for the owning terminal', async () => {
    const repo = new MemOrderRepo();
    await repo.create(order('TERM-1'));
    const res = await new OrderStatusController(new GetOrderStatusService(repo)).status('TERM-1', 'OC1');
    expect(res.orderCode).toBe('OC1');
    expect(res.status).toBe('PENDING');
  });
});
