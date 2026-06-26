/**
 * PROJECT TITAN — Terminal Profile types (Phase 3)
 *
 * A profile is a COMPOSITION of independent, typed dimensions — never a magic
 * number. The `101.x` label is human-facing only; identity is the UUID `id`.
 * These types are the single source of truth shared by backend (NestJS) and the
 * Android profile-verifier (mirrored in Kotlin).
 */

// ---- Dimension: how the operator/customer authorizes a transaction (Phase 1.2) ----
export type ApprovalType =
  | 'NONE'            // PINless / no CVM (low value, contactless)
  | 'PIN_CVM'         // cardholder PIN (4 or 6 digit)
  | 'OPERATOR_CODE'   // attendant / manager override code
  | 'OOB_OTP'         // out-of-band one-time code (3DS / step-up analog)
  | 'OPERATOR_CODE+OOB_OTP'; // dual control (high risk)

export interface ApprovalPolicy {
  type: ApprovalType;
  length: 4 | 6 | null;
  preAuth: boolean;                  // hold-then-capture
  stepUpTriggers: string[];          // e.g. ["amount>500", "newCustomer"]
}

// ---- Dimension: capture methods allowed per field (Phase 1.3) ----
export type CardCapture = 'EMV' | 'NFC' | 'MANUAL_MOTO' | 'TOKEN_COF';
export type WalletCapture = 'QR' | 'MANUAL' | 'SAVED_VERIFIED';

export interface CaptureMethods {
  card: CardCapture[];
  wallet: WalletCapture[];
}

// ---- Dimension: KYC level (Phase 8) ----
export type KycLevel =
  | 'NONE'
  | 'BASIC'
  | 'FULL'
  | 'FULL_LIVENESS'
  | 'ENHANCED';

// ---- Dimension: wallet validation policy (Phase 6) ----
export interface WalletValidation {
  enforceChecksum: boolean;          // EIP-55, Base58Check, Bech32 etc.
  screenDestination: boolean;        // chain-analytics screening
  blockMixers: boolean;
}

// ---- Dimension: transaction caps (Phase 7) ----
export interface TxCaps {
  perTxn: number;
  daily: number;
  currency: string;                  // ISO-4217
}

// ---- Dimension: crypto delivery strategy (Phase 5/6) ----
export type DeliveryStrategy =
  | 'BUY_THEN_SEND'
  | 'FLOAT_THEN_REBALANCE'
  | 'VOUCHER';

// ---- The composed profile ----
export interface ProfileDimensions {
  processorRoute: string;            // Phase 4 acquirer/MID route id
  approvalPolicy: ApprovalPolicy;
  captureMethods: CaptureMethods;
  kycLevel: KycLevel;
  assetSet: string[];                // e.g. ["BTC","ETH","USDT_TRON"]
  walletValidation: WalletValidation;
  riskTier: string;                  // Phase 7 rule-set id
  txCaps: TxCaps;
  settlementRoute: string;           // Phase 4 settlement route id
  compliancePack: string;            // Phase 8 jurisdiction pack id
  deliveryStrategy: DeliveryStrategy;
}

export interface TerminalProfile {
  id: string;                        // UUID — the real identity
  label: string;                     // "101.3" — human label only
  family: string;                    // "101"
  version: number;
  dimensions: ProfileDimensions;
  signature: string;                 // base64 Ed25519 over canonical(dimensions)
}

/**
 * A profile resolved for a specific device: family defaults ⊕ profile overrides
 * ⊕ jurisdiction pack, re-signed, with a cache TTL. The risk engine may TIGHTEN
 * caps at runtime but the resolved profile is the upper bound.
 */
export interface ResolvedProfile extends TerminalProfile {
  resolvedFor: string;               // device id
  etag: string;
  expiresAt: string;                 // ISO-8601; expired -> device uses DEGRADED
}

/**
 * Fail-safe profile used when no valid signed profile is available (expired /
 * tampered). Lowest caps, KYC required — fail-closed, never fail-open.
 */
export const DEGRADED_PROFILE_DIMENSIONS: ProfileDimensions = {
  processorRoute: 'none',
  approvalPolicy: { type: 'OOB_OTP', length: 6, preAuth: true, stepUpTriggers: ['*'] },
  captureMethods: { card: ['EMV'], wallet: ['QR'] },
  kycLevel: 'FULL_LIVENESS',
  assetSet: [],                      // no assets purchasable in degraded mode
  walletValidation: { enforceChecksum: true, screenDestination: true, blockMixers: true },
  riskTier: 'tier_lockdown',
  txCaps: { perTxn: 0, daily: 0, currency: 'EUR' },
  settlementRoute: 'none',
  compliancePack: 'STRICT',
  deliveryStrategy: 'BUY_THEN_SEND',
};
