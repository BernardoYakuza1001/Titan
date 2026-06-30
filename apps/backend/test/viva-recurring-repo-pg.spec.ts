/**
 * PROJECT TITAN — PgRecurringRepository round-trip against pg-mem.
 * (The 012 migration's ENUM + immutability triggers run on real Postgres; here we
 * use a trigger-free table to prove the SQL + idempotency + mapping.)
 */
import { newDb, DataType } from 'pg-mem';
import { randomUUID } from 'crypto';
import { PgRecurringRepository } from '../services/viva/pg-recurring.repository';
import { DuplicateCorrelationError } from '../services/viva/domain';
import { NewRecurringCharge } from '../services/viva/recurring.store';

function freshRepo(): PgRecurringRepository {
  const db = newDb();
  db.public.registerFunction({ name: 'gen_random_uuid', returns: DataType.uuid, impure: true, implementation: () => randomUUID() });
  db.public.none(`
    CREATE TABLE recurring_charge (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      correlation_token text NOT NULL UNIQUE,
      terminal_id text NOT NULL,
      merchant_id text NOT NULL,
      initial_transaction_id text NOT NULL,
      amount_minor bigint NOT NULL,
      currency text NOT NULL,
      viva_transaction_id text,
      error_log jsonb,
      status text NOT NULL DEFAULT 'RECURRING_CREATED',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );`);
  const { Pool } = db.adapters.createPg();
  return new PgRecurringRepository(new Pool());
}

const newC = (token = 'c1'): NewRecurringCharge => ({
  correlationToken: token, terminalId: 'TERM-1', merchantId: 'M', initialTransactionId: 'TX-INIT', amountMinor: 500, currency: 'EUR',
});

describe('PgRecurringRepository (pg-mem)', () => {
  it('creates a RECURRING_CREATED row and reads it back', async () => {
    const repo = freshRepo();
    const rec = await repo.create(newC());
    expect(rec.status).toBe('RECURRING_CREATED');
    expect(rec.amountMinor).toBe(500);
    expect(rec.initialTransactionId).toBe('TX-INIT');
    expect((await repo.findByCorrelationToken('c1'))?.id).toBe(rec.id);
  });

  it('rejects a duplicate correlation token with DuplicateCorrelationError', async () => {
    const repo = freshRepo();
    await repo.create(newC('dup'));
    await expect(repo.create(newC('dup'))).rejects.toBeInstanceOf(DuplicateCorrelationError);
  });

  it('updateStatus -> APPROVED records the MIT transaction id', async () => {
    const repo = freshRepo();
    const r = await repo.create(newC());
    const u = await repo.updateStatus(r.id, { status: 'RECURRING_APPROVED', vivaTransactionId: 'vt' });
    expect(u.status).toBe('RECURRING_APPROVED');
    expect(u.vivaTransactionId).toBe('vt');
  });
});
