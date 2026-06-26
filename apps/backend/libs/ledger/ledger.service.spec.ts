/**
 * PROJECT TITAN — ledger hash canonicalization regression (Principle P6)
 *
 * Guards the tamper-evidence guarantee against the previously-broken canonicalizer.
 * The old `JSON.stringify(payload, Object.keys(payload).sort())` used the array
 * form of the replacer as a RECURSIVE property allowlist, which erased every
 * nested object — so two events differing only in a nested field hashed
 * IDENTICALLY and verifyChain() could not detect the difference. These tests fail
 * against that implementation and pass against the recursive canonicalizer.
 */
import { hashEvent, LedgerService, type LedgerEvent, type LedgerStore } from './ledger.service';

const GENESIS = '0'.repeat(64);

describe('hashEvent — recursive canonicalization (P6 tamper-evidence)', () => {
  it('produces DIFFERENT hashes for payloads differing only in a NESTED field', () => {
    const a = hashEvent(GENESIS, 'QUOTED', { quote: { price: 100, venue: 'X' } });
    const b = hashEvent(GENESIS, 'QUOTED', { quote: { price: 101, venue: 'X' } });
    expect(a).not.toBe(b);
  });

  it('produces DIFFERENT hashes for objects nested inside arrays', () => {
    const a = hashEvent(GENESIS, 'BATCH', { items: [{ a: 1 }, { b: 2 }] });
    const b = hashEvent(GENESIS, 'BATCH', { items: [{ a: 1 }, { b: 3 }] });
    expect(a).not.toBe(b);
  });

  it('is order-independent at EVERY nesting level (deterministic for equal payloads)', () => {
    const a = hashEvent(GENESIS, 'T', { outer: { z: 9, y: 8 }, x: 1 });
    const b = hashEvent(GENESIS, 'T', { x: 1, outer: { y: 8, z: 9 } });
    expect(a).toBe(b);
  });

  it('still distinguishes flat-scalar payloads (no regression on the legacy path)', () => {
    const a = hashEvent(GENESIS, 'AUTHORIZED', { amount: 50, currency: 'EUR' });
    const b = hashEvent(GENESIS, 'AUTHORIZED', { amount: 51, currency: 'EUR' });
    expect(a).not.toBe(b);
  });
});

describe('LedgerService.verifyChain — detects tampering in a nested field', () => {
  /** Tiny in-memory store so the test stays a pure unit (no pg-mem needed). */
  class MemLedgerStore implements LedgerStore {
    private readonly byAgg = new Map<string, LedgerEvent[]>();
    async lastHash(aggregateId: string): Promise<string | null> {
      const evs = this.byAgg.get(aggregateId);
      return evs && evs.length ? evs[evs.length - 1].hash : null;
    }
    async append(event: LedgerEvent): Promise<void> {
      const evs = this.byAgg.get(event.aggregateId) ?? [];
      evs.push(event);
      this.byAgg.set(event.aggregateId, evs);
    }
    async list(aggregateId: string): Promise<LedgerEvent[]> {
      return [...(this.byAgg.get(aggregateId) ?? [])];
    }
    /** Mutate a persisted event's nested payload to simulate tampering. */
    tamperNested(aggregateId: string, index: number): void {
      const evs = this.byAgg.get(aggregateId)!;
      (evs[index].payload as { quote: { price: number } }).quote.price = 999;
    }
  }

  it('returns true for an intact nested-payload chain and false after nested tampering', async () => {
    const store = new MemLedgerStore();
    let tick = 0;
    const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, tick++)).toISOString();
    const ledger = new LedgerService(store, now);

    const agg = 'agg-1';
    await ledger.record(agg, 'QUOTED', { quote: { price: 100, venue: 'KRAKEN' } });
    await ledger.record(agg, 'QUOTED', { quote: { price: 200, venue: 'KRAKEN' } });

    expect(await ledger.verifyChain(agg)).toBe(true);

    // Tamper with a NESTED field only — the broken canonicalizer would NOT catch this.
    store.tamperNested(agg, 0);
    expect(await ledger.verifyChain(agg)).toBe(false);
  });
});
