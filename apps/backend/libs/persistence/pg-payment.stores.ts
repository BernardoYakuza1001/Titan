/**
 * PROJECT TITAN — Postgres payment-side stores (Deliverable 5)
 *
 *   * PgAuthRefStore  — implements AuthRefStore: txn -> acquirer ref to void.
 *   * PgRouteStore    — implements RouteStore: healthy acquirer candidates for
 *                       least-cost routing.
 *
 * All queries are parameterized ($1,$2,…). No value is ever string-concatenated
 * into SQL.
 */
import { randomUUID } from 'crypto';
import type { Db } from './db';
import type { AuthRefStore } from '../../services/payment/auth-engine.service';
import type { RouteCandidate, RouteStore } from '../../services/payment/payment-router.service';
import type { MerchantRoute } from '../../services/payment/gateway/payment-gateway.port';

type AuthRef = { processor: string; networkRef: string; routeId: string };

/**
 * Maps a transaction to the acquirer reference needed to void its auth. Backed
 * by the `authorizations` table. `put` inserts a new ref row; `get` returns the
 * most recent ref for the txn (last authorization wins).
 */
export class PgAuthRefStore implements AuthRefStore {
  constructor(private readonly db: Db) {}

  async put(txnId: string, ref: AuthRef): Promise<void> {
    await this.db.query(
      `INSERT INTO authorizations (id, txn_id, processor, network_ref, route_id, status)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), txnId, ref.processor, ref.networkRef, ref.routeId, 'AUTHORIZED'],
    );
  }

  async get(txnId: string): Promise<AuthRef | null> {
    const res = await this.db.query(
      `SELECT processor, network_ref, route_id
         FROM authorizations
        WHERE txn_id = $1 AND network_ref IS NOT NULL
        ORDER BY created_at DESC
        LIMIT 1`,
      [txnId],
    );
    if (!res.rows.length) return null;
    const r = res.rows[0];
    return { processor: r.processor, networkRef: r.network_ref, routeId: r.route_id };
  }
}

interface RouteRow {
  route_id: string;
  currency: string;
  processor: string;
  merchant_account: string;
  mid: string;
  healthy: boolean;
  success_rate: string | number;
  cost_bps: string | number;
}

/**
 * Reads acquirer candidates for a (routeId, currency) pair from
 * `payment_routes`. The router does its own healthy-filter + sort, so this just
 * returns every configured candidate mapped to the contract shape.
 */
export class PgRouteStore implements RouteStore {
  constructor(private readonly db: Db) {}

  async candidatesFor(routeId: string, currency: string): Promise<RouteCandidate[]> {
    const res = await this.db.query(
      `SELECT route_id, currency, processor, merchant_account, mid,
              healthy, success_rate, cost_bps
         FROM payment_routes
        WHERE route_id = $1 AND currency = $2`,
      [routeId, currency],
    );
    return res.rows.map((row) => this.toCandidate(row as RouteRow));
  }

  private toCandidate(row: RouteRow): RouteCandidate {
    const route: MerchantRoute = {
      routeId: row.route_id,
      processor: row.processor,
      merchantAccount: row.merchant_account,
      mid: row.mid,
    };
    return {
      route,
      healthy: row.healthy,
      successRate: toNum(row.success_rate),
      costBps: toNum(row.cost_bps),
    };
  }
}

function toNum(v: string | number): number {
  return typeof v === 'string' ? Number(v) : v;
}
