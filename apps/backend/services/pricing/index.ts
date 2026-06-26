/**
 * PROJECT TITAN — Pricing Engine (Phase 4/5) public barrel.
 *
 * The revenue model. The saga prices a transaction here BEFORE authorizing the
 * card (auth `fiatChargedMinor`) and BEFORE buying crypto (spend
 * `acquisitionBudgetMinor`), then reconciles realized margin after the fill.
 */
export * from './pricing.types';
export {
  PricingEngine,
  DEFAULT_PRICING_POLICY,
  RISK_TIER_MARKUP_BPS,
  policyForProfile,
  minorExponent,
  majorToMinor,
  minorToMajor,
} from './pricing.engine';
