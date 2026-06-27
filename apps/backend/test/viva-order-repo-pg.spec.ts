/**
 * PROJECT TITAN — PgOrderRepository round-trip against pg-mem (in-memory Postgres).
 * Proves the SQL: insert PENDING, idempotent unique(correlation_token), forward-only
 * markPaid/markFailed guarded by `WHERE status='PENDING'`, and bigint -> number
 * mapping. (The production 011 migration adds the ENUM + plpgsql immutability
 * triggers, which pg-mem doesn't run; those are exercised against real Postgres.)
 */
import { newDb } from 'pg-mem';
import { PgOrderRepository } from '../services/viva/pg-order.repository';
import { DuplicateOrderError, NewCheckoutOrder } from '../services/viva/checkout-order.store';

function freshRepo(): PgOrderRepository {
  const db = newDb();
  db.public.none(`
    CREATE TABLE checkout_order (
      order_code text PRIMARY KEY,
      correlation_token text NOT NULL UNIQUE,
      terminal_id text NOT NULL,
      merchant_id text NOT NULL,
      amount_minor bigint NOT NULL,
      currency text NOT NULL,
      status text NOT NULL DEFAULT 'PENDING',
      viva_transaction_id text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      paid_at timestamptz
    );`);
  const { Pool } = db.adapters.createPg();
  return new PgOrderRepository(new Pool());
}

const newOrder = (
  orderCode: string, correlationToken = 'corr-' + orderCode, terminalId = 'TERM-1',
): NewCheckoutOrder => ({
  orderCode, correlationToken, terminalId, merchantId: 'MERCH-1', amountMinor: 100, currency: 'EUR',
});

describe('PgOrderRepository (pg-mem)', () => {
  it('inserts a PENDING order and reads it back with correct types', async () => {
    const repo = freshRepo();
    const rec = await repo.create(newOrder('OC1'));
    expect(rec.status).toBe('PENDING');
    expect(rec.amountMinor).toBe(100);       // bigint mapped to number
    expect(rec.paidAt).toBeNull();
    expect(await repo.findByOrderCode('OC1')).not.toBeNull();
    expect((await repo.findByCorrelationToken('corr-OC1'))?.orderCode).toBe('OC1');
  });

  it('rejects a duplicate correlation_token with DuplicateOrderError', async () => {
    const repo = freshRepo();
    await repo.create(newOrder('OC1', 'dup'));
    await expect(repo.create(newOrder('OC2', 'dup'))).rejects.toBeInstanceOf(DuplicateOrderError);
  });

  it('markPaid transitions PENDING -> PAID once and is idempotent', async () => {
    const repo = freshRepo();
    await repo.create(newOrder('OC1'));
    const paid = await repo.markPaid('OC1', 'TXN-1');
    expect(paid?.status).toBe('PAID');
    expect(paid?.vivaTransactionId).toBe('TXN-1');
    expect(paid?.paidAt).not.toBeNull();
    // a second confirmation keeps the original transaction id (no double-credit)
    const again = await repo.markPaid('OC1', 'TXN-2');
    expect(again?.status).toBe('PAID');
    expect(again?.vivaTransactionId).toBe('TXN-1');
  });

  it('markFailed transitions PENDING -> FAILED and a later markPaid cannot flip it', async () => {
    const repo = freshRepo();
    await repo.create(newOrder('OC1'));
    expect((await repo.markFailed('OC1'))?.status).toBe('FAILED');
    expect((await repo.markPaid('OC1', 'TXN'))?.status).toBe('FAILED'); // guarded, unchanged
  });

  it('markPaid/markFailed on an unknown order return null', async () => {
    const repo = freshRepo();
    expect(await repo.markPaid('NOPE', 'T')).toBeNull();
    expect(await repo.markFailed('NOPE')).toBeNull();
  });
});
