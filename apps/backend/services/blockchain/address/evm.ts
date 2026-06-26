/**
 * PROJECT TITAN — EVM address validator (Phase 6)
 *
 * EVM addresses are the low 20 bytes of keccak_256(pubkey), rendered as 40 hex
 * chars with an OPTIONAL EIP-55 mixed-case checksum. The rules we enforce:
 *
 *   - exactly `0x` + 40 hex chars,
 *   - all-lowercase OR all-uppercase  -> accepted (no checksum present),
 *   - mixed-case                      -> MUST satisfy EIP-55 or we reject.
 *
 * Used by ETH / Polygon / Arbitrum / Optimism / Base / BNB — the address shape
 * is identical across the whole EVM family, so one validator covers all of them.
 *
 * We hand NOTHING to a hand-rolled hash: keccak_256 comes from @noble/hashes.
 */
import { keccak_256 } from '@noble/hashes/sha3';
import { AddressCheck, ok, fail } from './types';

const HEX40 = /^[0-9a-fA-F]{40}$/;
const ALL_LOWER = /^[0-9a-f]{40}$/;
const ALL_UPPER = /^[0-9A-F]{40}$/;

const ASCII = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
};

/**
 * Compute the canonical EIP-55 checksummed form of a 40-char (no-0x) hex body.
 * For each hex nibble of the address, the corresponding nibble of
 * keccak_256(lowercaseAddressAscii) decides the case: >= 8 -> uppercase.
 */
export function toEip55Checksum(body40Lower: string): string {
  const hash = keccak_256(ASCII(body40Lower)); // 32 bytes
  let out = '';
  for (let i = 0; i < 40; i++) {
    const c = body40Lower[i];
    if (c >= '0' && c <= '9') {
      out += c; // digits have no case
    } else {
      // nibble i of the hash: high nibble for even i, low nibble for odd i.
      const nibble = (hash[i >> 1] >> (i % 2 === 0 ? 4 : 0)) & 0x0f;
      out += nibble >= 8 ? c.toUpperCase() : c;
    }
  }
  return out;
}

export function validateEvmAddress(address: string): AddressCheck {
  if (typeof address !== 'string') return fail('NOT_A_STRING');
  if (!address.startsWith('0x') && !address.startsWith('0X')) return fail('MISSING_0X_PREFIX');
  const body = address.slice(2);
  if (body.length !== 40) return fail('WRONG_LENGTH');
  if (!HEX40.test(body)) return fail('NON_HEX');

  // No checksum to verify when the body is single-case.
  if (ALL_LOWER.test(body) || ALL_UPPER.test(body)) return ok;

  // Mixed case => an EIP-55 checksum is asserted and MUST verify exactly.
  const expected = toEip55Checksum(body.toLowerCase());
  return expected === body ? ok : fail('BAD_CHECKSUM');
}

/** Render an address into canonical EIP-55 form (used by EvmSender for safety). */
export function checksumEvmAddress(address: string): string {
  const body = address.replace(/^0[xX]/, '').toLowerCase();
  return '0x' + toEip55Checksum(body);
}
