/**
 * PROJECT TITAN — Bitcoin address validator (Phase 6)
 *
 * Covers the three address forms that can receive value on mainnet:
 *   - Legacy P2PKH  : base58check, version byte 0x00, 20-byte hash.
 *   - Legacy P2SH   : base58check, version byte 0x05, 20-byte hash.
 *   - SegWit (v0)   : bech32,  hrp "bc", program 20 (P2WPKH) or 32 (P2WSH) bytes.
 *   - SegWit (v1+)  : bech32m, hrp "bc", program 2..40 bytes (e.g. Taproot v1/32).
 *
 * TESTNET IS REJECTED: base58 versions 0x6F/0xC4 and the "tb"/"bcrt" hrps map to
 * test networks — delivering real value there would burn it, so we fail closed.
 *
 * Checksums are verified by @scure/base (base58check needs a sha256; bech32/
 * bech32m carry their own polymod). We never hand-roll any of it.
 */
import { createBase58check, bech32, bech32m } from '@scure/base';
import { sha256 } from '@noble/hashes/sha256';
import { AddressCheck, ok, fail } from './types';

// base58check wants the sha256 function injected; double-SHA256 is internal.
const b58check = createBase58check(sha256);

// Mainnet base58 version bytes.
const P2PKH_VERSION = 0x00;
const P2SH_VERSION = 0x05;
// Testnet/regtest base58 version bytes — explicitly rejected.
const TESTNET_P2PKH = 0x6f;
const TESTNET_P2SH = 0xc4;

function validateBase58(address: string): AddressCheck {
  let decoded: Uint8Array;
  try {
    decoded = b58check.decode(address); // throws on bad checksum / non-base58
  } catch {
    return fail('BAD_BASE58CHECK');
  }
  if (decoded.length !== 21) return fail('WRONG_LENGTH'); // 1 version + 20 hash
  const version = decoded[0];
  if (version === TESTNET_P2PKH || version === TESTNET_P2SH) return fail('TESTNET');
  if (version !== P2PKH_VERSION && version !== P2SH_VERSION) return fail('UNKNOWN_VERSION');
  return ok;
}

function validateSegwit(address: string): AddressCheck {
  const lower = address.toLowerCase();
  // Reject testnet ("tb1...") and regtest ("bcrt1...") human-readable parts.
  if (lower.startsWith('tb1') || lower.startsWith('bcrt1')) return fail('TESTNET');
  if (!lower.startsWith('bc1')) return fail('BAD_HRP');

  // Mixed case is illegal in bech32; require single-case as the spec mandates.
  if (address !== lower && address !== address.toUpperCase()) return fail('MIXED_CASE');

  // The witness version is the first data word: 0 => bech32, 1..16 => bech32m.
  let words: number[];
  try {
    const dec = bech32.decode(lower as `bc1${string}`, 90);
    words = dec.words;
  } catch {
    // bech32 decode also rejects bech32m, so fall through to a structural probe.
    try {
      const dec = bech32m.decode(lower as `bc1${string}`, 90);
      words = dec.words;
    } catch {
      return fail('BAD_BECH32');
    }
  }
  if (words.length === 0) return fail('EMPTY_PROGRAM');

  const witnessVersion = words[0];
  if (witnessVersion < 0 || witnessVersion > 16) return fail('BAD_WITNESS_VERSION');

  // Re-decode with the encoding the witness version REQUIRES, so a v0 address
  // encoded as bech32m (or vice-versa) is rejected exactly per BIP-350.
  const coder = witnessVersion === 0 ? bech32 : bech32m;
  let program: Uint8Array;
  try {
    program = coder.fromWords(words.slice(1));
  } catch {
    return fail('BAD_PROGRAM');
  }
  // Confirm the address actually round-trips under the required coder.
  try {
    if (coder.decode(lower as `bc1${string}`, 90).words.length === 0) return fail('BAD_BECH32');
  } catch {
    return fail('WRONG_ENCODING_FOR_VERSION');
  }

  if (witnessVersion === 0) {
    if (program.length !== 20 && program.length !== 32) return fail('BAD_PROGRAM_LENGTH');
  } else {
    if (program.length < 2 || program.length > 40) return fail('BAD_PROGRAM_LENGTH');
  }
  return ok;
}

export function validateBtcAddress(address: string): AddressCheck {
  if (typeof address !== 'string' || address.length === 0) return fail('EMPTY');
  const lower = address.toLowerCase();
  if (lower.startsWith('bc1') || lower.startsWith('tb1') || lower.startsWith('bcrt1')) {
    return validateSegwit(address);
  }
  return validateBase58(address);
}
