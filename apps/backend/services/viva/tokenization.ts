/**
 * PROJECT TITAN — server-side tokenization (PAX P2PE ciphertext -> Viva chargeToken).
 *
 * The POS captures the card inside PAX's secure processor and sends the BACKEND a
 * P2PE-ENCRYPTED payload (+ KSN + masked metadata) — never raw PAN/CVV. The
 * backend exchanges it with Viva for a single-use chargeToken, keeping the Viva
 * credentials (and any HSM P2PE decryption) server-side. Returns only a token.
 */
import { CardBrand, AcquiringError } from './domain';

/** What the POS sends: opaque ciphertext + non-sensitive display fields. */
export interface EncryptedCardPayload {
  encryptedPayload: string;   // base64 P2PE ciphertext (opaque without the DUKPT key)
  ksn: string;                // DUKPT key serial number
  maskedPan: string;          // "411111****1111"
  cardBrand: CardBrand;
  expiryMonth: number;
  expiryYear: number;
}

export interface TokenizeOutcome {
  ok: boolean;
  chargeToken?: string;
  expiresAtMs?: number;
  maskedPan?: string;
  cardBrand?: CardBrand;
  error?: AcquiringError;
}

/** Driven port: exchange an encrypted payload for a Viva chargeToken. */
export interface TokenizationGateway {
  tokenize(payload: EncryptedCardPayload, correlationToken: string): Promise<TokenizeOutcome>;
}

/** Driving port. */
export interface TokenizeUseCase {
  tokenize(payload: EncryptedCardPayload, correlationToken: string): Promise<TokenizeOutcome>;
}
