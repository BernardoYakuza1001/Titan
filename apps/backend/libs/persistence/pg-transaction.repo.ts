/**
 * PROJECT TITAN — Postgres transaction repository (Deliverable 5)
 *
 * Backs BOTH the saga's writer ({@link TxRepo}.save) and the controller's
 * lookups ({@link TxLookup}: byIdempotencyKey / create / byId). The
 * `transactions` row is a PROJECTION of the ledger; this repo upserts it on
 * every state transition.
 *
 * Mapping notes:
 *   * `profile` is the full signed ResolvedProfile — stored verbatim as jsonb in
 *     `profile_snapshot` so the TransactionContext can be rehydrated exactly;
 *     `profile_id` is denormalized from `profile.id` for indexing/joins.
 *   * money lives in `numeric(18,2)`; we keep `fiatAmount` as a JS number on the
 *     context (the saga's contract), parsing pg's string-numeric on read.
 *   * optional identity fields (customerId / cardToken / geoCountry) map to
 *     nullable columns; `undefined` <-> NULL.
 */
import type { Db } from './db';
import type { ResolvedProfile } from '@titan/profile-schema';
import type { TxState } from '../state-machine/transaction.state-machine';
import type { TransactionContext } from '../../services/transaction/transaction.saga';
import type { TransactionRepository } from './repository.contracts';

interface TxRow {
  id: string;
  device_id: string;
  profile_id: string;
  profile_snapshot: ResolvedProfile | string;
  state: string;
  fiat_amount: string | number;
  fiat_currency: string;
  asset: string;
  chain: string;
  dest_wallet: string;
  customer_id: string | null;
  card_token: string | null;
  geo_country: string | null;
  idempotency_key: string;
}

// We carry the idempotency key on the row but NOT on TransactionContext (the
// context has no such field). It is supplied to create()/save() via the context
// when available; if absent we derive a stable key from the id so the NOT NULL
// UNIQUE column is always satisfiable on upsert.
type ContextWithIdem = TransactionContext & { idempotencyKey?: string };

const SELECT_COLUMNS = `
  id, device_id, profile_id, profile_snapshot, state, fiat_amount, fiat_currency,
  asset, chain, dest_wallet, customer_id, card_token, geo_country, idempotency_key
`;

/**
 * UPSERT keyed on the primary key `id`. On conflict we refresh the mutable
 * projection columns (state, amounts, identity, snapshot) and bump updated_at.
 * idempotency_key is immutable after first insert (it identifies the request),
 * so it is NOT updated on conflict.
 */
const UPSERT_SQL = `
  INSERT INTO transactions (
    id, device_id, profile_id, profile_snapshot, state, fiat_amount, fiat_currency,
    asset, chain, dest_wallet, customer_id, card_token, geo_country, idempotency_key,
    created_at, updated_at
  ) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, now(), now()
  )
  ON CONFLICT (id) DO UPDATE SET
    profile_id       = EXCLUDED.profile_id,
    profile_snapshot = EXCLUDED.profile_snapshot,
    state            = EXCLUDED.state,
    fiat_amount      = EXCLUDED.fiat_amount,
    fiat_currency    = EXCLUDED.fiat_currency,
    asset            = EXCLUDED.asset,
    chain            = EXCLUDED.chain,
    dest_wallet      = EXCLUDED.dest_wallet,
    customer_id      = EXCLUDED.customer_id,
    card_token       = EXCLUDED.card_token,
    geo_country      = EXCLUDED.geo_country,
    updated_at       = now()
`;

export class PgTxRepo implements TransactionRepository {
  constructor(private readonly db: Db) {}

  /** Saga writer + idempotent upsert. */
  async save(ctx: TransactionContext): Promise<void> {
    await this.db.query(UPSERT_SQL, this.toParams(ctx));
  }

  /** Controller create — same idempotent upsert (first write of a transaction). */
  async create(ctx: TransactionContext): Promise<void> {
    await this.db.query(UPSERT_SQL, this.toParams(ctx));
  }

  async byId(id: string): Promise<TransactionContext | null> {
    const res = await this.db.query(
      `SELECT ${SELECT_COLUMNS} FROM transactions WHERE id = $1`,
      [id],
    );
    return res.rows.length ? this.toContext(res.rows[0] as TxRow) : null;
  }

  async byIdempotencyKey(key: string): Promise<TransactionContext | null> {
    const res = await this.db.query(
      `SELECT ${SELECT_COLUMNS} FROM transactions WHERE idempotency_key = $1`,
      [key],
    );
    return res.rows.length ? this.toContext(res.rows[0] as TxRow) : null;
  }

  // ---- mapping ----

  private toParams(ctx: TransactionContext): unknown[] {
    const c = ctx as ContextWithIdem;
    return [
      ctx.id,
      ctx.deviceId,
      ctx.profile.id,
      JSON.stringify(ctx.profile),
      ctx.state,
      ctx.fiatAmount,
      ctx.fiatCurrency,
      ctx.asset,
      ctx.chain,
      ctx.destWallet,
      ctx.customerId ?? null,
      ctx.cardToken ?? null,
      ctx.geoCountry ?? null,
      c.idempotencyKey ?? `txn:${ctx.id}`,
    ];
  }

  private toContext(row: TxRow): TransactionContext {
    const profile: ResolvedProfile =
      typeof row.profile_snapshot === 'string'
        ? (JSON.parse(row.profile_snapshot) as ResolvedProfile)
        : row.profile_snapshot;

    const ctx: ContextWithIdem = {
      id: row.id,
      deviceId: row.device_id,
      profile,
      fiatAmount: typeof row.fiat_amount === 'string' ? Number(row.fiat_amount) : row.fiat_amount,
      fiatCurrency: row.fiat_currency,
      asset: row.asset,
      chain: row.chain,
      destWallet: row.dest_wallet,
      state: row.state as TxState,
      customerId: row.customer_id ?? undefined,
      cardToken: row.card_token ?? undefined,
      geoCountry: row.geo_country ?? undefined,
      idempotencyKey: row.idempotency_key,
    };
    return ctx;
  }
}
