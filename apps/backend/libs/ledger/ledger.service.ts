/**
 * PROJECT TITAN — Event-sourced, hash-chained ledger (Principle P6, Deliverable 5/8)
 *
 * Append-only source of truth. Each event hashes the previous event's hash, so
 * any tampering breaks the chain and is detectable. Service tables (e.g.
 * `transactions`) are PROJECTIONS rebuildable by folding these events.
 *
 * In production the append is wrapped in the same DB transaction as the
 * projection update (outbox pattern) and mirrored to Kafka + WORM storage.
 */
import { createHash } from 'crypto';

export interface LedgerEvent {
  seq?: number;            // assigned by DB (bigserial)
  aggregateId: string;     // transaction id
  type: string;            // e.g. 'AUTHORIZED', 'CRYPTO_EXECUTED'
  payload: Record<string, unknown>;
  prevHash: string;
  hash: string;
  createdAt: string;       // ISO-8601 (passed in; clock is injected, not ambient)
}

const GENESIS = '0'.repeat(64);

/**
 * Recursively rebuild a value with object keys sorted at EVERY nesting level so
 * that two structurally-equal payloads always serialize to the identical string.
 *
 * NOTE: this replaces the previous `JSON.stringify(payload, Object.keys(...).sort())`
 * approach, which was broken: the array form of JSON.stringify's replacer is a
 * property ALLOWLIST applied recursively, so it erased every nested object
 * ({ a: { z: 9 } } -> {"a":{}}) and silently collapsed distinct nested payloads
 * to the same hash, defeating the P6 tamper-evidence guarantee. We sort keys
 * depth-first on plain objects and map over arrays (array order is significant).
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      out[key] = canonicalize(obj[key]);
    }
    return out;
  }
  // primitives (string, number, boolean, null, undefined) serialize as-is
  return value;
}

export function hashEvent(prevHash: string, type: string, payload: Record<string, unknown>): string {
  // canonical (sorted-key, recursive) serialization keeps the hash deterministic
  // for equal payloads while remaining sensitive to nested-field changes.
  const canonical = JSON.stringify(canonicalize(payload));
  return createHash('sha256').update(`${prevHash}|${type}|${canonical}`).digest('hex');
}

export interface LedgerStore {
  lastHash(aggregateId: string): Promise<string | null>;
  append(event: LedgerEvent): Promise<void>;
  list(aggregateId: string): Promise<LedgerEvent[]>;
}

export class LedgerService {
  constructor(
    private readonly store: LedgerStore,
    private readonly now: () => string, // injected clock (deterministic in tests)
  ) {}

  /** Append a new event, chaining from the aggregate's current head. */
  async record(
    aggregateId: string,
    type: string,
    payload: Record<string, unknown>,
  ): Promise<LedgerEvent> {
    const prevHash = (await this.store.lastHash(aggregateId)) ?? GENESIS;
    const hash = hashEvent(prevHash, type, payload);
    const event: LedgerEvent = {
      aggregateId, type, payload, prevHash, hash, createdAt: this.now(),
    };
    await this.store.append(event);
    return event;
  }

  /** Verify an aggregate's chain is intact (tamper-evidence check). */
  async verifyChain(aggregateId: string): Promise<boolean> {
    const events = await this.store.list(aggregateId);
    let prev = GENESIS;
    for (const e of events) {
      if (e.prevHash !== prev) return false;
      if (e.hash !== hashEvent(e.prevHash, e.type, e.payload)) return false;
      prev = e.hash;
    }
    return true;
  }
}
