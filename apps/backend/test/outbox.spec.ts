/**
 * PROJECT TITAN — Transactional-outbox proof (Deliverable 5/8, CENTERPIECE)
 *
 * Proves the four guarantees that make the ledger + Kafka stream consistent,
 * end-to-end, against pg-mem + the in-memory message producer:
 *
 *   a) ATOMICITY  — LedgerOutboxWriter.record(...) inside a working uow writes
 *                   BOTH a ledger_events row AND an outbox row.
 *   b) ROLLBACK   — if any step inside the same uow.run throws, NEITHER a ledger
 *                   row NOR an outbox row is persisted (no partial / dual write).
 *   c) RELAY      — OutboxRelayImpl.drainOnce() against an InMemoryMessageProducer
 *                   publishes the row and marks it published; a SECOND drainOnce
 *                   publishes NOTHING (at-least-once + idempotent, no dup).
 *   d) ORDERING   — two records for the same aggregateId publish in creation order.
 *
 * pg-mem accommodation: `FOR UPDATE SKIP LOCKED` is unsupported, so the
 * PgOutboxStore is built with `{ useSkipLocked: false }` (production keeps the
 * default `true`). Everything else is the real production code path.
 */
import { randomUUID } from 'crypto';

import type { Db, Tx } from '../libs/persistence/db';
import { PgLedgerStore } from '../libs/persistence/pg-ledger.store';
import { PgOutboxStore } from '../libs/messaging/outbox.store';
import {
  LedgerOutboxWriterImpl,
  type TxAwareLedgerStore,
} from '../libs/messaging/ledger-outbox.writer';
import { OutboxRelayImpl } from '../libs/messaging/outbox.relay';
import { InMemoryMessageProducer } from '../libs/messaging/kafka.producer';
import type { OutboxStore } from '../libs/messaging/messaging.ports';
import { Topics } from '../libs/messaging/topics';

import { applyMigrations, newPgDb } from './pg-mem.harness';

const TOPIC = Topics.LedgerTransaction;

/** Deterministic, strictly-increasing clock so created_at ordering is stable. */
function makeClock(): () => string {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, tick++)).toISOString();
}

/** Count helpers (rowCount-independent: pg-mem returns COUNT as a value). */
async function ledgerCount(db: Db, agg: string): Promise<number> {
  const r = await db.query('SELECT count(*)::int AS c FROM ledger_events WHERE aggregate_id = $1', [agg]);
  return Number(r.rows[0].c);
}
async function outboxCount(db: Db, agg: string): Promise<number> {
  const r = await db.query('SELECT count(*)::int AS c FROM outbox WHERE aggregate_id = $1', [agg]);
  return Number(r.rows[0].c);
}
async function unpublishedCount(db: Db, agg: string): Promise<number> {
  const r = await db.query(
    'SELECT count(*)::int AS c FROM outbox WHERE aggregate_id = $1 AND published_at IS NULL',
    [agg],
  );
  return Number(r.rows[0].c);
}

describe('transactional outbox (pg-mem + in-memory producer)', () => {
  let db: Db;
  let ledgerStore: PgLedgerStore;
  let outboxStore: PgOutboxStore;

  beforeEach(async () => {
    db = newPgDb();
    await applyMigrations(db);
    ledgerStore = new PgLedgerStore(db);
    // pg-mem accommodations: disable FOR UPDATE SKIP LOCKED (unsupported) and use
    // the IN-list id predicate (pg-mem won't match ANY(<uuid[] param>)).
    outboxStore = new PgOutboxStore(db, { useSkipLocked: false, arrayPredicate: 'in-list' });
  });

  afterEach(async () => {
    await db.close();
  });

  function newWriter(now = makeClock()): LedgerOutboxWriterImpl {
    return new LedgerOutboxWriterImpl(db, ledgerStore, outboxStore, now);
  }

  // ---------- a) ATOMICITY ----------
  it('a) ATOMICITY: record() writes BOTH a ledger row AND an outbox row', async () => {
    const writer = newWriter();
    const agg = randomUUID();

    const event = await writer.record(agg, 'AUTHORIZED', { amount: 50, currency: 'EUR' }, TOPIC);

    expect(event.prevHash).toBe('0'.repeat(64));        // chained from genesis
    expect(event.hash).toMatch(/^[0-9a-f]{64}$/);

    expect(await ledgerCount(db, agg)).toBe(1);
    expect(await outboxCount(db, agg)).toBe(1);

    // the outbox payload carries the full chained ledger event
    const row = await db.query('SELECT type, topic, key, payload, published_at FROM outbox WHERE aggregate_id = $1', [agg]);
    expect(row.rows[0].type).toBe('AUTHORIZED');
    expect(row.rows[0].topic).toBe(TOPIC);
    expect(row.rows[0].key).toBe(agg);                  // partition key = aggregateId
    expect(row.rows[0].published_at).toBeNull();        // pending
    const payload = typeof row.rows[0].payload === 'string' ? JSON.parse(row.rows[0].payload) : row.rows[0].payload;
    expect(payload.hash).toBe(event.hash);
    expect(payload.type).toBe('AUTHORIZED');
    expect(payload.payload).toEqual({ amount: 50, currency: 'EUR' });

    // and the ledger row matches the returned event hash
    const lr = await db.query('SELECT hash, prev_hash FROM ledger_events WHERE aggregate_id = $1', [agg]);
    expect(lr.rows[0].hash).toBe(event.hash);
    expect(lr.rows[0].prev_hash).toBe(event.prevHash);
  });

  // ---------- b) ROLLBACK ----------
  it('b) ROLLBACK: a throw inside the uow leaves NEITHER a ledger row NOR an outbox row', async () => {
    const now = makeClock();
    const agg = randomUUID();

    // Wrap the real outbox store so its insert throws AFTER the ledger append has
    // already run on the same tx — the classic partial-write window. The uow must
    // roll the whole transaction back.
    const explodingOutbox: OutboxStore = {
      insertTx: async () => { throw new Error('boom: simulated outbox insert failure'); },
      fetchUnpublished: outboxStore.fetchUnpublished.bind(outboxStore),
      markPublished: outboxStore.markPublished.bind(outboxStore),
      markFailed: outboxStore.markFailed.bind(outboxStore),
    };
    const writer = new LedgerOutboxWriterImpl(db, ledgerStore, explodingOutbox, now);

    await expect(writer.record(agg, 'AUTHORIZED', { amount: 50 }, TOPIC)).rejects.toThrow(/boom/);

    // No partial / dual write: the ledger append was rolled back too.
    expect(await ledgerCount(db, agg)).toBe(0);
    expect(await outboxCount(db, agg)).toBe(0);

    // sanity: the connection/pool is still usable after a rolled-back uow
    const writer2 = newWriter(now);
    await writer2.record(agg, 'AUTHORIZED', { amount: 50 }, TOPIC);
    expect(await ledgerCount(db, agg)).toBe(1);
    expect(await outboxCount(db, agg)).toBe(1);
  });

  it('b2) ROLLBACK: a throw in a wrapped step after BOTH writes still persists nothing', async () => {
    const now = makeClock();
    const agg = randomUUID();

    // Use the uow directly to interleave the real writer steps with a failing
    // post-step, proving atomicity holds even when the failure is downstream of
    // both the ledger AND the outbox insert.
    const ledgerTx: TxAwareLedgerStore = ledgerStore;
    await expect(
      db.run(async (tx: Tx) => {
        const prev = (await ledgerTx.lastHashTx(tx, agg)) ?? '0'.repeat(64);
        await ledgerTx.appendTx(tx, {
          aggregateId: agg, type: 'AUTHORIZED', payload: { a: 1 },
          prevHash: prev, hash: 'f'.repeat(64), createdAt: now(),
        });
        await outboxStore.insertTx(tx, {
          aggregateId: agg, type: 'AUTHORIZED', topic: TOPIC, key: agg,
          payload: { a: 1 }, createdAt: now(),
        });
        throw new Error('boom: downstream step failed');
      }),
    ).rejects.toThrow(/downstream/);

    expect(await ledgerCount(db, agg)).toBe(0);
    expect(await outboxCount(db, agg)).toBe(0);
  });

  // ---------- c) RELAY: at-least-once + idempotent ----------
  it('c) RELAY: drainOnce publishes + marks published; a second drainOnce does NOT duplicate', async () => {
    const writer = newWriter();
    const agg = randomUUID();
    await writer.record(agg, 'AUTHORIZED', { amount: 50 }, TOPIC);

    const producer = new InMemoryMessageProducer();
    const relay = new OutboxRelayImpl(outboxStore, producer, { stopOnError: true });

    // first drain: publishes exactly one and flips the row to published
    const n1 = await relay.drainOnce();
    expect(n1).toBe(1);
    expect(producer.published.length).toBe(1);
    expect(producer.published[0].topic).toBe(TOPIC);
    expect(producer.published[0].key).toBe(agg);
    expect(await unpublishedCount(db, agg)).toBe(0);

    // second drain: nothing left -> NO duplicate publish (idempotent)
    const n2 = await relay.drainOnce();
    expect(n2).toBe(0);
    expect(producer.published.length).toBe(1);
  });

  it('c2) RELAY: a publish failure keeps the row pending (at-least-once), retried next drain', async () => {
    const writer = newWriter();
    const agg = randomUUID();
    await writer.record(agg, 'AUTHORIZED', { amount: 50 }, TOPIC);

    const producer = new InMemoryMessageProducer();
    producer.failNext(1);                          // first publish attempt throws
    const relay = new OutboxRelayImpl(outboxStore, producer, { stopOnError: true });

    const n1 = await relay.drainOnce();
    expect(n1).toBe(0);                            // nothing published
    expect(producer.published.length).toBe(0);
    expect(await unpublishedCount(db, agg)).toBe(1); // still pending (not lost)

    // attempts bumped for backoff/poison detection
    const att = await db.query('SELECT attempts FROM outbox WHERE aggregate_id = $1', [agg]);
    expect(Number(att.rows[0].attempts)).toBe(1);

    // retry succeeds and publishes exactly once
    const n2 = await relay.drainOnce();
    expect(n2).toBe(1);
    expect(producer.published.length).toBe(1);
    expect(await unpublishedCount(db, agg)).toBe(0);
  });

  // ---------- d) ORDERING ----------
  it('d) ORDERING: two records for the same aggregateId publish in creation order', async () => {
    const writer = newWriter();
    const agg = randomUUID();

    await writer.record(agg, 'AUTHORIZED', { step: 1 }, TOPIC);
    await writer.record(agg, 'COMPLIANCE_PASS', { step: 2 }, TOPIC);
    await writer.record(agg, 'CRYPTO_FILLED', { step: 3 }, TOPIC);

    const producer = new InMemoryMessageProducer();
    const relay = new OutboxRelayImpl(outboxStore, producer, { stopOnError: true });
    const n = await relay.drainOnce();

    expect(n).toBe(3);
    const types = producer.published.map((m) => (m.value as { type: string }).type);
    expect(types).toEqual(['AUTHORIZED', 'COMPLIANCE_PASS', 'CRYPTO_FILLED']);
    // all on the same partition key => single Kafka partition => consumer FIFO
    expect(new Set(producer.published.map((m) => m.key))).toEqual(new Set([agg]));
  });

  it('d2) ORDERING: stopOnError halts the batch at the first failure (no overtaking)', async () => {
    const writer = newWriter();
    const agg = randomUUID();
    await writer.record(agg, 'AUTHORIZED', { step: 1 }, TOPIC);
    await writer.record(agg, 'COMPLIANCE_PASS', { step: 2 }, TOPIC);
    await writer.record(agg, 'CRYPTO_FILLED', { step: 3 }, TOPIC);

    const producer = new InMemoryMessageProducer();
    // publish #1 ok, publish #2 fails -> batch must STOP (step 3 must not overtake step 2)
    const realPublish = producer.publish.bind(producer);
    let calls = 0;
    producer.publish = async (topic, key, value) => {
      calls++;
      if (calls === 2) throw new Error('simulated broker failure on step 2');
      return realPublish(topic, key, value);
    };
    const relay = new OutboxRelayImpl(outboxStore, producer, { stopOnError: true });

    // the published value is the full ledger event; the per-record marker is under payload
    const steps = () =>
      producer.published.map((m) => (m.value as { payload: { step: number } }).payload.step);

    const n1 = await relay.drainOnce();
    expect(n1).toBe(1);                                  // only step 1 published
    expect(steps()).toEqual([1]);
    expect(await unpublishedCount(db, agg)).toBe(2);     // steps 2 and 3 still pending

    // next drain (producer healthy now) finishes the rest IN ORDER
    const n2 = await relay.drainOnce();
    expect(n2).toBe(2);
    expect(steps()).toEqual([1, 2, 3]);
    expect(await unpublishedCount(db, agg)).toBe(0);
  });
});
