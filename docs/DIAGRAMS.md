# PROJECT TITAN — Architecture Diagrams (Deliverables 1–4, 7, 9)

Rendered with Mermaid (GitHub/most viewers render natively).

## 1. System Architecture

```mermaid
flowchart TB
  subgraph Edge["Terminal Fleet (10k+)"]
    T["Android POS Terminal<br/>(attested, kiosk, thin client)"]
  end
  subgraph CP["Control Plane"]
    GW["API Gateway / BFF<br/>mTLS · authN · rate limit"]
    AUTHS["Auth Svc"]
    DEV["Device / Fleet Svc"]
    PROF["Profile Svc"]
  end
  subgraph DP["Data / Money Plane"]
    TX["Transaction Svc + Saga"]
    RISK["Risk Svc"]
    COMP["Compliance Svc"]
    EXEC["Crypto Exec Svc"]
    CHAIN["Blockchain Delivery Svc"]
    SET["Settlement / Recon Svc"]
    AUD["Audit / Ledger"]
  end
  subgraph Ext["External"]
    ACQ["Acquirers / Processors"]
    CEX["Exchanges<br/>Kraken·Coinbase·Binance·OKX"]
    BC["Blockchains / Node providers"]
    KYCV["KYC / Sanctions / Travel-Rule vendors"]
    HSM["HSM / MPC custody"]
  end
  T -- mTLS --> GW
  GW --> AUTHS & DEV & PROF & TX
  TX --> RISK & COMP & EXEC & CHAIN & SET
  TX & RISK & COMP & EXEC & CHAIN & SET --> AUD
  TX --> ACQ
  EXEC --> CEX
  CHAIN --> BC
  COMP --> KYCV
  EXEC & CHAIN --> HSM
```

## 2. Android Architecture

```mermaid
flowchart TB
  subgraph App["Application layer"]
    L["Custom Launcher (COSU kiosk)"]
    POS["POS App (thin client)"]
    ADMIN["Admin App"]
    AGENT["Attestation + OTA Agent"]
  end
  subgraph Mgd["Managed services"]
    DPC["Device Policy Controller<br/>(Android Enterprise)"]
  end
  subgraph FW["Android Framework (hardened AOSP 11+)"]
    SEL["SELinux enforcing"]
    KM["KeyMint / StrongBox"]
    PI["Play Integrity"]
  end
  subgraph TEE["TEE / Secure Element"]
    SE["PIN/EMV · device keys (non-exportable)"]
  end
  subgraph Boot["Boot"]
    AVB["Verified Boot (AVB) + dm-verity"]
    ROT["HW Root of Trust (eFuse)"]
  end
  L --> DPC
  POS --> AGENT --> KM
  KM --> SE
  FW --> TEE --> Boot
  ROT --> AVB --> SEL
```

## 3. Backend Architecture (NestJS microservices)

```mermaid
flowchart LR
  GW["API Gateway"] --> AUTHS & DEV & PROF & TX
  TX["Transaction Svc<br/>(Saga + State Machine)"]
  TX -->|sync gRPC| RISK & COMP & EXEC
  TX -->|events| KAFKA[("Kafka")]
  KAFKA --> SET & AUD & NOTIF & REPORT & CHAIN
  subgraph Stores
    PG[("Postgres per-svc")]
    REDIS[("Redis")]
    VAULT[("Vault / KMS / HSM")]
  end
  AUTHS & DEV & PROF & TX & RISK & COMP & EXEC & CHAIN & SET --> PG
  RISK --> REDIS
  EXEC & CHAIN --> VAULT
```

## 4. Firmware Boot / Security Chain

```mermaid
sequenceDiagram
  participant ROT as HW RoT (eFuse)
  participant BL as Bootloader (locked)
  participant K as Kernel (dm-verity)
  participant TEE as KeyMint/StrongBox
  participant L as Launcher (COSU)
  participant BE as Backend Device Svc
  ROT->>BL: verify signature
  BL->>K: AVB verify boot image
  K->>TEE: mount verity system; unseal keys if green
  TEE-->>L: device keys available (attested boot only)
  L->>BE: enroll/attest (HW key attestation + Play Integrity)
  BE-->>L: short-lived mTLS session (only if attestation passes)
```

## 5. Transaction State Machine (Phase 4)

```mermaid
stateDiagram-v2
  [*] --> CREATED
  CREATED --> CAPTURED_INPUT: INPUT_CAPTURED
  CAPTURED_INPUT --> AUTHORIZING: AUTH_REQUESTED
  AUTHORIZING --> AUTHORIZED: AUTH_APPROVED
  AUTHORIZING --> DECLINED: AUTH_DECLINED
  AUTHORIZED --> RISK_REVIEW: COMPLIANCE_PASS
  AUTHORIZED --> REVERSED: COMPLIANCE_FAIL
  RISK_REVIEW --> APPROVED: RISK_PASS
  RISK_REVIEW --> REVERSED: RISK_FAIL
  APPROVED --> CRYPTO_PENDING: CRYPTO_QUEUED
  CRYPTO_PENDING --> CRYPTO_EXECUTING: CRYPTO_FILLED
  CRYPTO_PENDING --> REVERSED: CRYPTO_EXEC_FAILED
  CRYPTO_EXECUTING --> DELIVERING: BROADCAST_OK
  CRYPTO_EXECUTING --> FAILED: BROADCAST_FAILED
  DELIVERING --> CONFIRMING: CONFIRMED
  CONFIRMING --> COMPLETED: CONFIRMED
  COMPLETED --> CHARGEBACK: CHARGEBACK_RECEIVED
  DECLINED --> [*]
  REVERSED --> [*]
  FAILED --> [*]
  COMPLETED --> [*]
```

> Note the bright line after `CRYPTO_FILLED`: everything before is fiat-reversible
> (compensate → REVERSED); everything after is irreversible (→ FAILED + treasury case).

## 7. Event Flow (happy path, ledger-recorded)

```mermaid
sequenceDiagram
  participant Dev as Terminal
  participant TX as Transaction Saga
  participant CMP as Compliance
  participant RSK as Risk
  participant ACQ as Acquirer
  participant EX as Exchange
  participant CH as Chain
  Dev->>TX: POST /transactions (idempotencyKey)
  TX->>ACQ: authorize fiat
  ACQ-->>TX: AUTHORIZED (ledger++)
  TX->>CMP: KYC + sanctions + travel rule (blocking)
  CMP-->>TX: pass (ledger++)
  TX->>RSK: real-time score (blocking)
  RSK-->>TX: pass (ledger++)
  TX->>EX: best-execution spot buy
  EX-->>TX: filled (ledger++  <-- commit point)
  TX->>CH: broadcast withdrawal
  CH-->>TX: txid -> confirmations
  TX-->>Dev: COMPLETED (ledger chain intact)
```
