# PROJECT TITAN — Reference Implementation (Spine)

Implementation-grade core of the [Final Enterprise Blueprint](../00_MASTER_BLUEPRINT.md).
This is the **spine** everything else hangs off: the Phase 3 profile engine and
the Phase 4 transaction state machine + saga, with a hash-chained ledger and the
device-side verifier. It is deliberately built before the custody decision (it
only depends on *ports*, not concrete exchanges/chains).

## What's here

```
titan/                              # npm workspaces monorepo (root tsconfig project refs)
├─ packages/
│  └─ profile-schema/             # shared types + Zod schema + Ed25519 verify (Phase 3)
│     └─ src/profile.types.ts     #   typed dimensions, DEGRADED fail-safe profile
│        profile.schema.ts        #   shape (Zod) + origin (signature) verification
├─ apps/
│  ├─ backend/                    # NestJS monorepo
│  │  ├─ libs/
│  │  │  ├─ state-machine/        # pure FSM (Phase 4) + tests — the spine
│  │  │  ├─ ledger/               # append-only hash-chained ledger (P6)
│  │  │  ├─ persistence/          # Postgres repos + UnitOfWork (Tx) + migrate runner (Phase 9)
│  │  │  └─ messaging/            # transactional outbox → Kafka writer + relay + inbox dedup
│  │  ├─ services/
│  │  │  ├─ transaction/          # saga orchestrator + API controller + address gate (Phase 4)
│  │  │  ├─ payment/              # gateway adapter (Adyen) + router + auth engine (Phase 4)
│  │  │  ├─ crypto-exec/          # exchange adapters + smart-order-router + exec engine (Phase 5)
│  │  │  ├─ blockchain/           # address validators + senders + delivery engine (Phase 6)
│  │  │  ├─ compliance/           # KYC/sanctions/wallet/travel-rule engine + packs (Phase 8)
│  │  │  └─ profile/              # resolver (merge ⊕ pack ⊕ override, re-sign, TTL)
│  │  ├─ migrations/              # 001_core · 002_outbox · 003_inbox (SQL DDL)
│  │  └─ test/                    # blocking-gates · persistence · outbox · crypto-exec ·
│  │                              #   blockchain · e2e-delivery · saga-resume (+ pg-mem harness)
│  └─ android/
│     └─ pos-app/.../ProfileVerifier.kt   # device-side fail-closed verifier (Phase 2/3)
└─ docs/DIAGRAMS.md               # Deliverables 1–4, 7, 9 (mermaid)
```

## The two ideas that make it safe

1. **Profiles are signed data, not code.** `101.x` is a label over a UUID-keyed
   composition of typed dimensions. The device verifies the signature every
   transaction; expired/tampered → `DEGRADED` (caps = 0). This is the Phase 1
   "never hardcode assumptions" instruction made literal.

2. **There is a bright line at `CRYPTO_FILLED`.** Before it, every failure path
   (compliance, risk, exec error) compensates by voiding the fiat auth →
   `REVERSED`. After it, crypto is irreversible, so failures go to `FAILED` +
   a treasury reconciliation case — money is never silently lost, and crypto is
   never delivered before compliance + risk pass (blocking gates, Principle P2).

## Run the proof

```bash
npm install            # npm workspaces (root); pnpm is fine too once a lockfile is added
npm run build          # tsc -b across project references
npm test               # typechecks specs (tsconfig.spec.json) then runs jest — 33 tests, 5 suites
```

What the suite proves (all against in-memory fakes + `pg-mem`, no Docker):
- **state-machine** — happy path, fiat reversal on compliance/risk failure, post-commit states are NOT fiat-reversible, illegal transitions throw.
- **blocking-gates** — the real saga + auth engine + compliance engine: sanctioned customer / blocked wallet / insufficient KYC each **void the fiat auth and never execute crypto**; auth-declined needs no void.
- **persistence** — every Postgres repo round-trips (ledger chain intact, txn upsert by idempotency key, profile/route/case stores).
- **outbox** (the centerpiece) — ledger append + outbox insert are **atomic** (both or neither), the relay is **at-least-once + idempotent** (re-draining never double-publishes), and per-aggregate **ordering** holds (by `seq`, not wall-clock).
- **ledger canonicalization** — recursive hash regression tests (nested-field changes must change the hash).

> The Postgres layer is verified against `pg-mem` (in-process). A few production-only SQL features (`FOR UPDATE SKIP LOCKED`, advisory locks, `ANY($1::uuid[])`) are flag-guarded so the **production Postgres SQL is the default** and tests exercise a pg-mem-compatible path. Run against a real Postgres before production sign-off.

## Status & next slices

**Done (115 tests / 11 suites green):** profile engine (3) · transaction state machine + saga, re-entrant on the post-commit side (4) · payment gateway/router/auth engine (4) · **crypto execution: exchange adapters + smart-order-router + best-net-price + slippage + fallback + idempotent buy (5)** · **blockchain delivery: 9-chain address validation + BTC/EVM senders + base-unit BigInt + idempotent send + confirmation/retry (6)** · pre-commit destination-address gate (4) · compliance engine + jurisdiction packs (8) · hash-chained ledger (P6) · Postgres persistence repos + UnitOfWork (9) · transactional outbox → Kafka writer + relay + inbox dedup (9).

| Next slice | Wire up | Blueprint phase |
|------------|---------|-----------------|
| Composition root | inject Pg repos + outbox writer + real engines into the live saga (replace in-memory stores) | 9 |
| Risk adapter | `RiskPort` → Redis feature store + rule eval (today: allow-all fake) | 7 |
| Tron/Solana senders | concrete broadcast (validators already done; senders are NOT_IMPLEMENTED stubs) | 6 |
| Real-Postgres CI | run persistence/outbox specs against Postgres (testcontainers), not just pg-mem | 9 |
| Multi-worker relay + delivery reserve | back `reserve()` + outbox lease with a real Postgres `INSERT … ON CONFLICT` / `UPDATE … RETURNING` | 9 |
| Fleet/profile assignment | profile CRUD + signed push to devices | 3/10 |

All adapters plug into the existing ports in `transaction.saga.ts` — the saga and
state machine do not change as you add processors, exchanges, or chains. That is
the payoff of the abstraction.

## Decision recap (why this shape)
- **Ports & a pure FSM** so the irreversible-money logic is unit-testable and
  unchanged by vendor swaps.
- **Hash-chained ledger as source of truth**; service tables are projections →
  full auditability and replay (Deliverable 5/8/11).
- **Fail-closed device profile** so a stale/compromised terminal can't transact
  beyond the safe baseline.
