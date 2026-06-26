/**
 * PROJECT TITAN — Persistence round-trip proof (Deliverable 5, integration)
 *
 * Stands up the FULL schema in pg-mem (in-memory Postgres, no Docker), applies the
 * real numbered migrations via the migrate() runner against a `pg`-compatible
 * Pool wrapped in the production PgDb adapter, then round-trips EVERY repository
 * (save/get) the two parallel agents produced:
 *
 *   - PgLedgerStore         append + list with an intact hash chain
 *   - PgTxRepo              upsert (save/create) + byId + byIdempotencyKey
 *   - PgAuthRefStore        put/get
 *   - PgProfileRepo         assignedProfileId / profileById / *Overrides
 *   - PgRouteStore          candidatesFor (least-cost routing candidates)
 *   - PgComplianceCaseStore open (COMPLIANCE case)
 *   - PgTreasuryCaseStore   openTreasuryReconciliation (TREASURY case)
 *
 * pg-mem accommodations (see notes in newMemDb): none needed for these repos —
 * every column/type the migrations use (uuid, jsonb, numeric, bytea, bigserial,
 * ON CONFLICT upsert) is supported. The only engine limit (FOR UPDATE SKIP
 * LOCKED) lives in the outbox relay and is exercised in outbox.spec.ts.
 */
import { randomUUID } from 'crypto';
import type { ResolvedProfile, ProfileDimensions } from '@titan/profile-schema';

import type { Db } from '../libs/persistence/db';
import { PgLedgerStore } from '../libs/persistence/pg-ledger.store';
import { PgTxRepo } from '../libs/persistence/pg-transaction.repo';
import { PgAuthRefStore, PgRouteStore } from '../libs/persistence/pg-payment.stores';
import { PgComplianceCaseStore, PgTreasuryCaseStore } from '../libs/persistence/pg-case.stores';
import { PgProfileRepo } from '../libs/persistence/pg-profile.repo';
import { LedgerService } from '../libs/ledger/ledger.service';
import type { TransactionContext } from '../services/transaction/transaction.saga';

import { applyMigrations, newPgDb } from './pg-mem.harness';

// ---------- fixtures ----------

function dims(over: Partial<ProfileDimensions> = {}): ProfileDimensions {
  return {
    processorRoute: 'route_eu_a',
    approvalPolicy: { type: 'OOB_OTP', length: 6, preAuth: true, stepUpTriggers: [] },
    captureMethods: { card: ['EMV'], wallet: ['QR'] },
    kycLevel: 'FULL_LIVENESS',
    assetSet: ['BTC'],
    walletValidation: { enforceChecksum: true, screenDestination: true, blockMixers: true },
    riskTier: 'tier_std',
    txCaps: { perTxn: 1000, daily: 3000, currency: 'EUR' },
    settlementRoute: 'settle_eu',
    compliancePack: 'EU_MiCA_TFR',
    deliveryStrategy: 'BUY_THEN_SEND',
    ...over,
  };
}

function resolvedProfile(id: string, deviceId: string): ResolvedProfile {
  return {
    id,
    label: '101.3',
    family: '101',
    version: 1,
    dimensions: dims(),
    signature: 'sig_base64',
    resolvedFor: deviceId,
    etag: 'etag1',
    expiresAt: '2999-01-01T00:00:00.000Z',
  };
}

function txContext(over: Partial<TransactionContext> & { idempotencyKey?: string } = {}): TransactionContext & { idempotencyKey?: string } {
  const id = over.id ?? randomUUID();
  const deviceId = over.deviceId ?? randomUUID();
  const profile = over.profile ?? resolvedProfile(randomUUID(), deviceId);
  return {
    id,
    deviceId,
    profile,
    fiatAmount: 50,
    fiatCurrency: 'EUR',
    asset: 'BTC',
    chain: 'BTC',
    destWallet: 'bc1qexample',
    state: 'CREATED',
    customerId: randomUUID(),
    cardToken: 'tok_1',
    geoCountry: 'DE',
    ...over,
  };
}

// ---------- suite ----------

describe('persistence round-trip (pg-mem)', () => {
  let db: Db;

  beforeEach(async () => {
    db = newPgDb();
    const applied = await applyMigrations(db);
    expect(applied).toBeGreaterThan(0);
  });

  afterEach(async () => {
    await db.close();
  });

  describe('PgLedgerStore — append + list with intact hash chain', () => {
    it('persists a chained ledger and verifyChain() passes', async () => {
      const store = new PgLedgerStore(db);
      let clock = 0;
      const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, clock++)).toISOString();
      const ledger = new LedgerService(store, now);

      const agg = randomUUID();
      const e1 = await ledger.record(agg, 'AUTHORIZED', { amount: 50, currency: 'EUR' });
      const e2 = await ledger.record(agg, 'COMPLIANCE_PASS', { reasons: ['KYC_OK'] });
      const e3 = await ledger.record(agg, 'CRYPTO_FILLED', { qty: '0.01' });

      // chain links: genesis -> e1 -> e2 -> e3
      expect(e1.prevHash).toBe('0'.repeat(64));
      expect(e2.prevHash).toBe(e1.hash);
      expect(e3.prevHash).toBe(e2.hash);

      const listed = await store.list(agg);
      expect(listed.map((e) => e.type)).toEqual(['AUTHORIZED', 'COMPLIANCE_PASS', 'CRYPTO_FILLED']);
      // seq is the bigserial — must be strictly increasing
      expect(listed.map((e) => e.seq)).toEqual([...listed.map((e) => e.seq)].sort((a, b) => (a! - b!)));
      // payload round-tripped as an object (jsonb)
      expect(listed[0].payload).toEqual({ amount: 50, currency: 'EUR' });

      // the whole chain is intact and tamper-evident
      expect(await ledger.verifyChain(agg)).toBe(true);
      expect(await store.lastHash(agg)).toBe(e3.hash);
    });

    it('keeps separate aggregates independent', async () => {
      const store = new PgLedgerStore(db);
      const now = () => '2026-01-01T00:00:00.000Z';
      const ledger = new LedgerService(store, now);
      const a = randomUUID();
      const b = randomUUID();
      await ledger.record(a, 'AUTHORIZED', { n: 1 });
      await ledger.record(b, 'AUTHORIZED', { n: 2 });
      expect((await store.list(a)).length).toBe(1);
      expect((await store.list(b)).length).toBe(1);
      expect(await store.lastHash(randomUUID())).toBeNull();
    });
  });

  describe('PgTxRepo — upsert + byId + byIdempotencyKey', () => {
    it('round-trips a transaction context and upserts on save', async () => {
      const repo = new PgTxRepo(db);
      const idemKey = `idem_${randomUUID()}`;
      const ctx = txContext({ idempotencyKey: idemKey });

      await repo.create(ctx);

      const byId = await repo.byId(ctx.id);
      expect(byId).not.toBeNull();
      expect(byId!.id).toBe(ctx.id);
      expect(byId!.deviceId).toBe(ctx.deviceId);
      expect(byId!.fiatAmount).toBe(50);          // numeric parsed back to a JS number
      expect(typeof byId!.fiatAmount).toBe('number');
      expect(byId!.state).toBe('CREATED');
      expect(byId!.profile.id).toBe(ctx.profile.id);          // full snapshot rehydrated
      expect(byId!.profile.dimensions.kycLevel).toBe('FULL_LIVENESS');

      const byKey = await repo.byIdempotencyKey(idemKey);
      expect(byKey).not.toBeNull();
      expect(byKey!.id).toBe(ctx.id);

      // upsert (save) mutates state in place — same row, same idempotency key
      ctx.state = 'AUTHORIZED';
      ctx.fiatAmount = 75;
      await repo.save(ctx);
      const updated = await repo.byId(ctx.id);
      expect(updated!.state).toBe('AUTHORIZED');
      expect(updated!.fiatAmount).toBe(75);
      expect((await repo.byIdempotencyKey(idemKey))!.id).toBe(ctx.id);
    });

    it('returns null for unknown id / key', async () => {
      const repo = new PgTxRepo(db);
      expect(await repo.byId(randomUUID())).toBeNull();
      expect(await repo.byIdempotencyKey('nope')).toBeNull();
    });

    it('derives a stable idempotency key when the context carries none', async () => {
      const repo = new PgTxRepo(db);
      const ctx = txContext();                  // no idempotencyKey on context
      await repo.create(ctx);
      const stored = await repo.byIdempotencyKey(`txn:${ctx.id}`);
      expect(stored).not.toBeNull();
      expect(stored!.id).toBe(ctx.id);
    });
  });

  describe('PgAuthRefStore — put/get', () => {
    it('stores and retrieves the acquirer ref needed to void', async () => {
      const store = new PgAuthRefStore(db);
      const txnId = randomUUID();
      expect(await store.get(txnId)).toBeNull();

      await store.put(txnId, { processor: 'adyen', networkRef: 'psp_abc', routeId: 'route_eu_a' });
      const ref = await store.get(txnId);
      expect(ref).toEqual({ processor: 'adyen', networkRef: 'psp_abc', routeId: 'route_eu_a' });

      // last authorization wins
      await store.put(txnId, { processor: 'checkout', networkRef: 'psp_xyz', routeId: 'route_eu_b' });
      expect((await store.get(txnId))!.networkRef).toBe('psp_xyz');
    });
  });

  describe('PgProfileRepo — assignment / profile / overrides', () => {
    it('reads the assigned profile, the profile row, and partial overrides', async () => {
      const repo = new PgProfileRepo(db);
      const deviceId = randomUUID();
      const profileId = randomUUID();

      // seed a profile + assignment + overrides directly (the repo is read-only)
      await db.query(
        `INSERT INTO profiles (id, label, family, version, dimensions, signature)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
        [profileId, '101.3', '101', 1, JSON.stringify(dims()), Buffer.from('sigbytes')],
      );
      await db.query(
        `INSERT INTO profile_assignments (device_id, profile_id, effective_at)
         VALUES ($1, $2, now())`,
        [deviceId, profileId],
      );
      await db.query(
        `INSERT INTO profile_overrides (scope, scope_key, dimensions)
         VALUES ($1, $2, $3::jsonb)`,
        ['family', '101', JSON.stringify({ riskTier: 'tier_family' })],
      );
      await db.query(
        `INSERT INTO profile_overrides (scope, scope_key, dimensions)
         VALUES ($1, $2, $3::jsonb)`,
        ['device', deviceId, JSON.stringify({ riskTier: 'tier_device' })],
      );
      await db.query(
        `INSERT INTO profile_overrides (scope, scope_key, dimensions)
         VALUES ($1, $2, $3::jsonb)`,
        ['pack', 'EU_MiCA_TFR', JSON.stringify({ kycLevel: 'ENHANCED' })],
      );

      expect(await repo.assignedProfileId(deviceId)).toBe(profileId);
      expect(await repo.assignedProfileId(randomUUID())).toBeNull();

      const profile = await repo.profileById(profileId);
      expect(profile).not.toBeNull();
      expect(profile!.id).toBe(profileId);
      expect(profile!.family).toBe('101');
      expect(profile!.dimensions.processorRoute).toBe('route_eu_a');
      expect(typeof profile!.signature).toBe('string');          // bytea -> base64 string
      expect(profile!.signature.length).toBeGreaterThan(0);

      expect(await repo.familyDefaults('101')).toEqual({ riskTier: 'tier_family' });
      expect(await repo.deviceOverride(deviceId)).toEqual({ riskTier: 'tier_device' });
      expect(await repo.compliancePackOverrides('EU_MiCA_TFR')).toEqual({ kycLevel: 'ENHANCED' });
      // missing override => {} (fail-safe)
      expect(await repo.familyDefaults('999')).toEqual({});
      expect(await repo.profileById(randomUUID())).toBeNull();
    });
  });

  describe('PgRouteStore — candidatesFor', () => {
    it('returns configured acquirer candidates mapped to the contract shape', async () => {
      const store = new PgRouteStore(db);
      const routeId = 'route_eu_a';
      await db.query(
        `INSERT INTO payment_routes (route_id, currency, processor, merchant_account, mid, healthy, success_rate, cost_bps)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [routeId, 'EUR', 'adyen', 'TitanEU', 'mid_1', true, 0.99, 80],
      );
      await db.query(
        `INSERT INTO payment_routes (route_id, currency, processor, merchant_account, mid, healthy, success_rate, cost_bps)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [routeId, 'EUR', 'checkout', 'TitanEU2', 'mid_2', false, 0.50, 40],
      );

      const candidates = await store.candidatesFor(routeId, 'EUR');
      expect(candidates.length).toBe(2);
      const adyen = candidates.find((c) => c.route.processor === 'adyen')!;
      expect(adyen.route).toEqual({ routeId, processor: 'adyen', merchantAccount: 'TitanEU', mid: 'mid_1' });
      expect(adyen.healthy).toBe(true);
      expect(adyen.successRate).toBe(0.99);     // numeric parsed to JS number
      expect(typeof adyen.successRate).toBe('number');
      expect(adyen.costBps).toBe(80);

      // unknown route => empty
      expect(await store.candidatesFor('route_none', 'EUR')).toEqual([]);
    });
  });

  describe('PgComplianceCaseStore + PgTreasuryCaseStore — case persistence', () => {
    it('opens a COMPLIANCE case with reasons[] in jsonb notes', async () => {
      const store = new PgComplianceCaseStore(db);
      const txnId = randomUUID();
      await store.open(txnId, ['SANCTIONS_HIT:OFAC-SDN', 'KYC_INSUFFICIENT']);

      const res = await db.query(
        `SELECT type, status, notes FROM compliance_cases WHERE txn_id = $1`,
        [txnId],
      );
      expect(res.rows.length).toBe(1);
      expect(res.rows[0].type).toBe('COMPLIANCE');
      expect(res.rows[0].status).toBe('OPEN');
      const notes = typeof res.rows[0].notes === 'string' ? JSON.parse(res.rows[0].notes) : res.rows[0].notes;
      expect(notes).toEqual({ reasons: ['SANCTIONS_HIT:OFAC-SDN', 'KYC_INSUFFICIENT'] });
    });

    it('opens a TREASURY_RECONCILIATION case with the detail object', async () => {
      const store = new PgTreasuryCaseStore(db);
      const txnId = randomUUID();
      await store.openTreasuryReconciliation(txnId, { stage: 'post_commit', qty: '0.01', reason: 'BROADCAST_FAILED' });

      const res = await db.query(
        `SELECT type, status, notes FROM compliance_cases WHERE txn_id = $1`,
        [txnId],
      );
      expect(res.rows.length).toBe(1);
      expect(res.rows[0].type).toBe('TREASURY_RECONCILIATION');
      const notes = typeof res.rows[0].notes === 'string' ? JSON.parse(res.rows[0].notes) : res.rows[0].notes;
      expect(notes.stage).toBe('post_commit');
      expect(notes.qty).toBe('0.01');
    });
  });
});
