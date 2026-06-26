/**
 * PROJECT TITAN — Compliance ports (Phase 8)
 *
 * Pluggable vendor interfaces. The engine orchestrates them; adapters wrap
 * Sumsub/Onfido (KYC), Chainalysis/Elliptic (wallet screening), the sanctions
 * list provider, and a Travel Rule network (Notabene/TRP). Swapping a vendor =
 * a new adapter, no engine change.
 */
import { KycLevel } from '@titan/profile-schema';

// ---- KYC ----
export interface KycStatus {
  level: KycLevel;       // highest verified level for this customer
  status: 'VERIFIED' | 'PENDING' | 'REJECTED' | 'NONE';
  customerId: string | null;
}
export interface KycPort {
  /** Current verified KYC for a customer (null customer => NONE). */
  getStatus(customerId: string | null): Promise<KycStatus>;
}

// ---- Sanctions (identity) ----
export interface SanctionsHit {
  hit: boolean;
  lists: string[];       // e.g. ["OFAC-SDN","EU","UN"]
  details?: string;
}
export interface SanctionsPort {
  screenCustomer(customerId: string | null): Promise<SanctionsHit>;
}

// ---- Counterparty wallet screening (chain analytics) ----
export interface WalletRisk {
  blocked: boolean;
  category?: 'sanctioned' | 'mixer' | 'fraud' | 'darknet' | 'clean' | string;
  score?: number;        // 0..100
}
export interface WalletScreeningPort {
  screenAddress(chain: string, address: string): Promise<WalletRisk>;
}

// ---- Travel Rule ----
export interface TravelRuleResult {
  required: boolean;
  satisfied: boolean;    // message sent/acknowledged for required transfers
  ref?: string;
}
export interface TravelRulePort {
  evaluate(input: {
    amountMinor: number; currency: string; chain: string; destWallet: string; customerId: string | null;
    thresholdMinor: number;
  }): Promise<TravelRuleResult>;
}
