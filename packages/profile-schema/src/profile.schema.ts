/**
 * PROJECT TITAN — Profile validation + signature verification (Phase 3)
 *
 * Two independent guarantees before a device or service trusts a profile:
 *   1. SHAPE  — dimensions conform to the typed schema (Zod).
 *   2. ORIGIN — the signature over the canonical dimensions verifies against a
 *               trusted control-plane public key (Ed25519).
 * A profile failing either check is rejected; the device falls to DEGRADED.
 */
import { z } from 'zod';
import * as nacl from 'tweetnacl';
import { TerminalProfile, ProfileDimensions } from './profile.types';

export const approvalPolicySchema = z.object({
  type: z.enum(['NONE', 'PIN_CVM', 'OPERATOR_CODE', 'OOB_OTP', 'OPERATOR_CODE+OOB_OTP']),
  length: z.union([z.literal(4), z.literal(6), z.null()]),
  preAuth: z.boolean(),
  stepUpTriggers: z.array(z.string()),
});

export const dimensionsSchema: z.ZodType<ProfileDimensions> = z.object({
  processorRoute: z.string().min(1),
  approvalPolicy: approvalPolicySchema,
  captureMethods: z.object({
    card: z.array(z.enum(['EMV', 'NFC', 'MANUAL_MOTO', 'TOKEN_COF'])).min(1),
    wallet: z.array(z.enum(['QR', 'MANUAL', 'SAVED_VERIFIED'])).min(1),
  }),
  kycLevel: z.enum(['NONE', 'BASIC', 'FULL', 'FULL_LIVENESS', 'ENHANCED']),
  assetSet: z.array(z.string()),
  walletValidation: z.object({
    enforceChecksum: z.boolean(),
    screenDestination: z.boolean(),
    blockMixers: z.boolean(),
  }),
  riskTier: z.string().min(1),
  txCaps: z.object({
    perTxn: z.number().nonnegative(),
    daily: z.number().nonnegative(),
    currency: z.string().length(3),
  }).refine((c) => c.daily >= c.perTxn, 'daily cap must be >= per-txn cap'),
  settlementRoute: z.string().min(1),
  compliancePack: z.string().min(1),
  deliveryStrategy: z.enum(['BUY_THEN_SEND', 'FLOAT_THEN_REBALANCE', 'VOUCHER']),
});

export const profileSchema: z.ZodType<TerminalProfile> = z.object({
  id: z.string().uuid(),
  label: z.string(),
  family: z.string(),
  version: z.number().int().positive(),
  dimensions: dimensionsSchema,
  signature: z.string(),
});

/**
 * Deterministic canonical JSON (sorted keys) so signer and verifier hash the
 * exact same bytes regardless of language/serializer ordering.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
}

export interface ProfileVerifyResult {
  ok: boolean;
  reason?: 'SCHEMA' | 'SIGNATURE';
  errors?: string[];
}

/**
 * Verify shape THEN origin. `controlPlanePubKey` is the 32-byte Ed25519 public
 * key pinned in firmware / service config (rotated via signed OTA).
 */
export function verifyProfile(
  profile: unknown,
  controlPlanePubKey: Uint8Array,
): ProfileVerifyResult {
  const parsed = profileSchema.safeParse(profile);
  if (!parsed.success) {
    return { ok: false, reason: 'SCHEMA', errors: parsed.error.issues.map((i) => i.message) };
  }
  const p = parsed.data;
  const message = new TextEncoder().encode(canonicalize(p.dimensions));
  const sig = Uint8Array.from(Buffer.from(p.signature, 'base64'));
  const valid = nacl.sign.detached.verify(message, sig, controlPlanePubKey);
  return valid ? { ok: true } : { ok: false, reason: 'SIGNATURE' };
}

/** Control-plane only: sign a profile's dimensions. Private key lives in HSM/KMS. */
export function signDimensions(dimensions: ProfileDimensions, secretKey: Uint8Array): string {
  const message = new TextEncoder().encode(canonicalize(dimensions));
  return Buffer.from(nacl.sign.detached(message, secretKey)).toString('base64');
}
