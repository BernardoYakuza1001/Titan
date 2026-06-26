-- PROJECT TITAN — Core schema (Deliverable 5)
-- Canonical DDL derived from 02_DATA_AND_API.md, restricted to the tables the
-- persistence repositories in libs/persistence actually read/write.
--
-- Portability: written to apply against BOTH real PostgreSQL and pg-mem (tests).
--   * No CREATE EXTENSION / gen_random_uuid() here — ids are generated in the
--     application layer (the contracts already pass ids in), so the DB never
--     needs pgcrypto/uuid-ossp.
--   * Every index is explicitly named (pg-mem dislikes anonymous CREATE INDEX
--     and re-running anonymous names across migrations).
--   * `bytea` columns store raw bytes (device pubkey, profile signature); pg-mem
--     accepts bytea. Where a value is conceptually a string (hashes, tokens) we
--     use text.
--   * IF NOT EXISTS guards make every statement idempotent for repeat runs.

-- ============ Device service ============
CREATE TABLE IF NOT EXISTS devices (
  id              uuid PRIMARY KEY,
  serial          text UNIQUE NOT NULL,
  model           text NOT NULL,
  pubkey          bytea NOT NULL,
  rot_hash        text NOT NULL,
  status          text NOT NULL,             -- ENROLLING|ACTIVE|QUARANTINED|WIPED
  profile_id      uuid,                      -- current assigned profile
  region          text NOT NULL,
  last_seen_at    timestamptz,
  created_at      timestamptz DEFAULT now()
);

-- ============ Profile service ============
CREATE TABLE IF NOT EXISTS profiles (
  id          uuid PRIMARY KEY,
  label       text,
  family      text,
  version     int NOT NULL,
  dimensions  jsonb NOT NULL,                -- full ProfileDimensions JSON
  signature   bytea,                         -- Ed25519 over canonical(dimensions)
  created_at  timestamptz DEFAULT now(),
  UNIQUE (label, version)
);

-- Device -> profile assignment history. assignedProfileId() reads the most
-- recent (effective_at) row for a device.
CREATE TABLE IF NOT EXISTS profile_assignments (
  device_id     uuid NOT NULL,
  profile_id    uuid NOT NULL,
  effective_at  timestamptz NOT NULL DEFAULT now(),
  assigned_by   uuid,
  PRIMARY KEY (device_id, effective_at)
);
CREATE INDEX IF NOT EXISTS ix_profile_assignments_device
  ON profile_assignments (device_id, effective_at);

-- Partial-dimension override sources merged by the ProfileResolver. One row per
-- (scope, scope_key): scope='family' keyed by family, 'device' keyed by device
-- id, 'pack' keyed by compliance pack id. `dimensions` holds a PARTIAL
-- ProfileDimensions JSON object.
CREATE TABLE IF NOT EXISTS profile_overrides (
  scope       text NOT NULL,                   -- family | device | pack
  scope_key   text NOT NULL,
  dimensions  jsonb NOT NULL,                  -- Partial<ProfileDimensions>
  created_at  timestamptz DEFAULT now(),
  PRIMARY KEY (scope, scope_key)
);

-- ============ Transaction service ============
-- Projection of the ledger; PgTxRepo upserts on every saga transition.
-- profile_snapshot keeps the full ResolvedProfile JSON used by the saga so the
-- TransactionContext can be rehydrated byId / byIdempotencyKey.
CREATE TABLE IF NOT EXISTS transactions (
  id                uuid PRIMARY KEY,
  device_id         uuid NOT NULL,
  profile_id        uuid NOT NULL,
  profile_snapshot  jsonb NOT NULL,          -- serialized ResolvedProfile
  state             text NOT NULL,           -- TxState (state machine)
  fiat_amount       numeric(18,2) NOT NULL,
  fiat_currency     text NOT NULL,
  asset             text NOT NULL,           -- BTC, ETH, ...
  chain             text NOT NULL,
  dest_wallet       text NOT NULL,
  customer_id       uuid,                    -- null => no verified customer on file
  card_token        text,                    -- network token; never raw PAN
  geo_country       text,                    -- ISO-3166-1 alpha-2
  quote_price       numeric(38,18),
  crypto_amount     numeric(38,18),
  idempotency_key   text UNIQUE NOT NULL,
  created_at        timestamptz DEFAULT now(),
  updated_at        timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_transactions_device_created
  ON transactions (device_id, created_at);
CREATE INDEX IF NOT EXISTS ix_transactions_state
  ON transactions (state);

-- ============ Event-sourced ledger (append-only source of truth) ============
-- prev_hash/hash are STORED as provided by the ledger service — the persistence
-- layer never recomputes them (the chaining contract lives in ledger.service).
CREATE TABLE IF NOT EXISTS ledger_events (
  seq           bigserial PRIMARY KEY,
  aggregate_id  uuid NOT NULL,               -- transaction id
  type          text NOT NULL,               -- e.g. AUTHORIZED, CRYPTO_EXECUTED
  payload       jsonb NOT NULL,
  prev_hash     text NOT NULL,               -- hash chain
  hash          text NOT NULL,               -- H(prev_hash || type || canonical(payload))
  created_at    timestamptz DEFAULT now(),
  -- Belt-and-suspenders against a forked chain: two concurrent appends for the
  -- same aggregate that both read the same head hash would both try to chain
  -- from it. This UNIQUE makes the second writer fail loudly (instead of silently
  -- forking the chain). The per-aggregate advisory lock in LedgerOutboxWriter
  -- serializes the common path; this constraint is the durable last line.
  UNIQUE (aggregate_id, prev_hash)
);
CREATE INDEX IF NOT EXISTS ix_ledger_events_aggregate_seq
  ON ledger_events (aggregate_id, seq);

-- ============ Authorizations / Settlement ============
-- Backs PgAuthRefStore.put/get (txn -> acquirer ref needed to void).
CREATE TABLE IF NOT EXISTS authorizations (
  id           uuid PRIMARY KEY,
  txn_id       uuid NOT NULL,
  processor    text,
  mid          text,
  route_id     text,                          -- route used (for re-pick on void)
  auth_code    text,
  network_ref  text,                          -- pspReference / acquirer ref
  status       text,
  amount       numeric(18,2),
  created_at   timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_authorizations_txn
  ON authorizations (txn_id);

CREATE TABLE IF NOT EXISTS crypto_orders (
  id               uuid PRIMARY KEY,
  txn_id           uuid,
  venue            text,
  client_order_id  text UNIQUE,
  asset            text,
  side             text,
  qty              numeric(38,18),
  avg_price        numeric(38,18),
  status           text,
  created_at       timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_crypto_orders_txn
  ON crypto_orders (txn_id);

-- ============ Risk / Compliance ============
CREATE TABLE IF NOT EXISTS risk_decisions (
  id          uuid PRIMARY KEY,
  txn_id      uuid,
  score       numeric,
  decision    text,
  reasons     jsonb,
  created_at  timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_risk_decisions_txn
  ON risk_decisions (txn_id);

-- Backs PgComplianceCaseStore.open and PgTreasuryCaseStore (CasePort). `type`
-- distinguishes COMPLIANCE vs TREASURY_RECONCILIATION cases.
CREATE TABLE IF NOT EXISTS compliance_cases (
  id          uuid PRIMARY KEY,
  txn_id      uuid,
  type        text,                           -- COMPLIANCE | TREASURY_RECONCILIATION
  status      text,
  assignee    uuid,
  notes       jsonb,                          -- reasons[] / detail object
  created_at  timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_compliance_cases_txn
  ON compliance_cases (txn_id);

-- ============ Payment route config ============
-- Backs PgRouteStore.candidatesFor(routeId, currency): healthy acquirer
-- candidates with rolling success-rate and cost for least-cost routing.
CREATE TABLE IF NOT EXISTS payment_routes (
  route_id          text NOT NULL,            -- profile.dimensions.processorRoute
  currency          text NOT NULL,            -- ISO-4217 this candidate serves
  processor         text NOT NULL,            -- adyen | checkout | stripe | ...
  merchant_account  text NOT NULL,
  mid               text NOT NULL,
  healthy           boolean NOT NULL DEFAULT true,
  success_rate      numeric NOT NULL DEFAULT 1,   -- rolling 0..1
  cost_bps          numeric NOT NULL DEFAULT 0,   -- basis points; lower cheaper
  PRIMARY KEY (route_id, currency, processor)
);
CREATE INDEX IF NOT EXISTS ix_payment_routes_lookup
  ON payment_routes (route_id, currency);
