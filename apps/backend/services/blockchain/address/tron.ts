/**
 * PROJECT TITAN — Tron address validator (Phase 6)
 *
 * A Tron mainnet address is base58check over [0x41 || 20-byte-keccak-hash], so
 * the human form always starts with "T" and decodes to 21 bytes. We verify the
 * checksum (base58check / double-sha256) and the mandatory 0x41 version prefix.
 *
 * Checksum is done by @scure/base; we never hand-roll it.
 */
import { createBase58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha256';
import { AddressCheck, ok, fail } from './types';

const b58check = createBase58check(sha256);
const TRON_MAINNET_PREFIX = 0x41;

export function validateTronAddress(address: string): AddressCheck {
  if (typeof address !== 'string' || address.length === 0) return fail('EMPTY');
  // Mainnet addresses are conventionally 34 base58 chars beginning with 'T'.
  if (!address.startsWith('T')) return fail('BAD_PREFIX_CHAR');

  let decoded: Uint8Array;
  try {
    decoded = b58check.decode(address);
  } catch {
    return fail('BAD_BASE58CHECK');
  }
  if (decoded.length !== 21) return fail('WRONG_LENGTH'); // 1 prefix + 20 hash
  if (decoded[0] !== TRON_MAINNET_PREFIX) return fail('NOT_MAINNET_PREFIX');
  return ok;
}
