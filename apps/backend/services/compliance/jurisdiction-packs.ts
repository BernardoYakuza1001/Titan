/**
 * PROJECT TITAN — Jurisdiction packs (Phase 8)
 *
 * Compliance rules as DATA, selected per profile via `compliancePack`. Adding a
 * market = adding a pack, not forking code. Thresholds are illustrative defaults
 * to be confirmed by counsel per jurisdiction before go-live.
 *
 * Each pack declares: the MINIMUM KYC level required at/above given amounts, the
 * Travel Rule threshold, and whether counterparty wallet screening is mandatory.
 */
import { KycLevel } from '@titan/profile-schema';

export interface KycThreshold {
  /** if txn amount (minor units) >= atOrAbove, require >= level */
  atOrAboveMinor: number;
  requireLevel: KycLevel;
}

export interface JurisdictionPack {
  id: string;
  region: string;
  kycThresholds: KycThreshold[];        // evaluated; strictest matching wins
  travelRuleThresholdMinor: number;     // 0 => always required (e.g. EU CASP-to-CASP)
  mandatoryWalletScreening: boolean;
  sanctionsLists: string[];
}

const order: KycLevel[] = ['NONE', 'BASIC', 'FULL', 'FULL_LIVENESS', 'ENHANCED'];
export function kycAtLeast(actual: KycLevel, required: KycLevel): boolean {
  return order.indexOf(actual) >= order.indexOf(required);
}

/** Highest KYC level demanded by a pack for a given amount. */
export function requiredKyc(pack: JurisdictionPack, amountMinor: number): KycLevel {
  let req: KycLevel = 'NONE';
  for (const t of pack.kycThresholds) {
    if (amountMinor >= t.atOrAboveMinor && order.indexOf(t.requireLevel) > order.indexOf(req)) {
      req = t.requireLevel;
    }
  }
  return req;
}

export const PACKS: Record<string, JurisdictionPack> = {
  EU_MiCA_TFR: {
    id: 'EU_MiCA_TFR', region: 'EU',
    kycThresholds: [
      { atOrAboveMinor: 0, requireLevel: 'BASIC' },
      { atOrAboveMinor: 100_00, requireLevel: 'FULL' },          // >= €100
      { atOrAboveMinor: 1000_00, requireLevel: 'FULL_LIVENESS' },// >= €1000
    ],
    travelRuleThresholdMinor: 0,         // TFR: CASP transfers carry originator info from €0
    mandatoryWalletScreening: true,
    sanctionsLists: ['EU', 'UN', 'OFAC-SDN'],
  },
  UK_FCA_MLR: {
    id: 'UK_FCA_MLR', region: 'UK',
    kycThresholds: [
      { atOrAboveMinor: 0, requireLevel: 'BASIC' },
      { atOrAboveMinor: 1000_00, requireLevel: 'FULL' },
    ],
    travelRuleThresholdMinor: 1000_00,   // ~£1000 equivalent
    mandatoryWalletScreening: true,
    sanctionsLists: ['UK-HMT', 'UN', 'OFAC-SDN'],
  },
  US_FINCEN: {
    id: 'US_FINCEN', region: 'US',
    kycThresholds: [
      { atOrAboveMinor: 0, requireLevel: 'BASIC' },
      { atOrAboveMinor: 300_00, requireLevel: 'FULL' },          // CDD on crypto purchases
      { atOrAboveMinor: 3000_00, requireLevel: 'FULL_LIVENESS' },// recordkeeping rule territory
    ],
    travelRuleThresholdMinor: 3000_00,   // $3000 Travel Rule
    mandatoryWalletScreening: true,
    sanctionsLists: ['OFAC-SDN'],
  },
  UAE_VARA: {
    id: 'UAE_VARA', region: 'UAE',
    kycThresholds: [
      { atOrAboveMinor: 0, requireLevel: 'FULL' },
      { atOrAboveMinor: 3500_00, requireLevel: 'FULL_LIVENESS' },// ~AED equivalent
    ],
    travelRuleThresholdMinor: 3500_00,
    mandatoryWalletScreening: true,
    sanctionsLists: ['UN', 'OFAC-SDN', 'UAE-LOCAL'],
  },
  STRICT: { // fail-safe pack used by DEGRADED profile
    id: 'STRICT', region: 'GLOBAL',
    kycThresholds: [{ atOrAboveMinor: 0, requireLevel: 'ENHANCED' }],
    travelRuleThresholdMinor: 0,
    mandatoryWalletScreening: true,
    sanctionsLists: ['OFAC-SDN', 'EU', 'UN', 'UK-HMT'],
  },
};
