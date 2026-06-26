/**
 * PROJECT TITAN — Address validation result type (Phase 6)
 *
 * Every family validator returns this shape. `reason` is a stable machine code
 * (NOT a sentence) so the saga/compliance layer and tests can branch on it.
 */
export interface AddressCheck {
  valid: boolean;
  /** Stable reason code when invalid, e.g. BAD_CHECKSUM, WRONG_LENGTH, TESTNET. */
  reason?: string;
}

export const ok: AddressCheck = { valid: true };
export const fail = (reason: string): AddressCheck => ({ valid: false, reason });
