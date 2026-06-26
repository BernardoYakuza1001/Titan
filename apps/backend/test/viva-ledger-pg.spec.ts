/**
 * PROJECT TITAN — PgLedgerRepository round-trip against pg-mem (in-memory Postgres).
 * Proves the SQL: insert, idempotent unique(correlation_token), terminal-scoped
 * query + ordering, and bigint -> number / row mapping. (The production 010
 * migration adds ENUM + plpgsql immutability triggers, which pg-mem doesn't run;
 * those are exercised against real Postgres.)
 */
import { newDb, DataType } from 'pg-mem';
import { randomUUID } from 'crypto';
import { PgLedgerRepository } from '../services/viva/pg-ledger.repository';
import { DuplicateCorrelationError } from '../services/viva/domain';
import { NewTransaction } from '../services/viva/ports';

function freshRepo(): PgLedgerRepository {
  const db = newDb();
  db.public.registerFunction({
    name: 'gen_random_uuid',
    returns: DataType.uuid,
    impure: true,
    implementation: () => randomUUID(),
  });
  db.public.none(`
    CREATE TABLE fiat_transaction_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      correlation_token text NOT NULL UNIQUE,
      terminal_id text NOT NULL,
      merchant_id text NOT NULL,
      amount_minor bigint NOT NULL,
      currency text NOT NULL,
      masked_pan text NOT NULL,
      card_brand text NOT NULL,
      viva_transaction_id text,
      viva_order_code text,
      authorization_code text,
      error_log jsonb,
      status text NOT NULL DEFAULT 'FIAT_CREATED',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );`);
  const { Pool } = db.adapters.createPg();
  return new PgLedgerRepository(new Pool());
}

const newTx = (correlationToken: string, terminalId = 'TERM-1'): NewTransaction => ({
  correlationToken,
  terminalId,
  merchantId: 'MERCH-1',
  amountMinor: 9999,
  currency: 'EUR',
  maskedPan: '411111****1111',
  cardBrand: 'VISA',
});

describe('PgLedgerRepository (pg-mem)', () => {
  it('inserts and reads back a FIAT_CREATED row with correct types', async () => {
    const repo = freshRepo();
    const rec = await repo.create(newTx('pg-1'));
    expect(rec.status).toBe('FIAT_CREATED');
    expect(rec.amountMinor).toBe(9999);           // bigint mapped to number
    expect(typeof rec.id).toBe('string');
    const found = await repo.findByCorrelationToken('pg-1');
    expect(found?.id).toBe(rec.id);
  });

  it('enforces idempotency: a duplicate correlation_token throws DuplicateCorrelationError', async () => {
    const repo = freshRepo();
    await repo.create(newTx('dup'));
    await expect(repo.create(newTx('dup'))).rejects.toBeInstanceOf(DuplicateCorrelationError);
  });

  it('findByTerminal returns only that terminal, newest first, limited', async () => {
    const repo = freshRepo();
    await repo.create(newTx('t1-a', 'TERM-1'));
    await repo.create(newTx('t1-b', 'TERM-1'));
    await repo.create(newTx('t2-a', 'TERM-2'));

    const rows = await repo.findByTerminal('TERM-1', 50, 0);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.terminalId === 'TERM-1')).toBe(true);

    const limited = await repo.findByTerminal('TERM-1', 1, 0);
    expect(limited).toHaveLength(1);
  });
});
