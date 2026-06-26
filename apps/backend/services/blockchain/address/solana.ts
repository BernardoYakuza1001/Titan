/**
 * PROJECT TITAN — Solana address validator (Phase 6)
 *
 * A Solana address is the raw base58 encoding of a 32-byte ed25519 public key
 * (no checksum, no version byte). Validation is therefore: decodes as base58 AND
 * the decoded length is exactly 32 bytes — the valid on-curve point length.
 *
 * We deliberately do NOT do a full ed25519 on-curve test here: many legitimate
 * destinations (Program Derived Addresses / token accounts) are intentionally
 * OFF-curve yet are valid 32-byte recipients. Length == 32 is the correct,
 * non-rejecting structural check; a stricter on-curve gate belongs in screening.
 *
 * base58 decode comes from @scure/base.
 */
import { base58 } from '@scure/base';
import { AddressCheck, ok, fail } from './types';

const ED25519_PUBKEY_LEN = 32;

export function validateSolanaAddress(address: string): AddressCheck {
  if (typeof address !== 'string' || address.length === 0) return fail('EMPTY');
  // Fast structural reject: base58 has a fixed alphabet and a length band.
  if (address.length < 32 || address.length > 44) return fail('OUT_OF_LENGTH_BAND');

  let decoded: Uint8Array;
  try {
    decoded = base58.decode(address);
  } catch {
    return fail('NOT_BASE58');
  }
  if (decoded.length !== ED25519_PUBKEY_LEN) return fail('NOT_32_BYTES');
  return ok;
}
