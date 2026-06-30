/**
 * PROJECT TITAN — Phase 1 fiat acquiring — DOMAIN (pure, framework-free).
 *
 * Entities + value objects for MOTO card-not-present acquiring via Viva Wallet.
 * NOTE: there is no PAN/CVV anywhere in the domain. The POS tokenizes the card
 * inside a PCI-certified component; only a single-use `paymentToken` + masked PAN
 * ever reach the backend.
 */

export type FiatStatus = 'FIAT_CREATED' | 'FIAT_PROCESSING' | 'FIAT_APPROVED' | 'FIAT_DECLINED';

export type CardBrand =
  | 'VISA' | 'MASTERCARD' | 'AMEX' | 'DISCOVER' | 'DINERS' | 'JCB' | 'UNIONPAY' | 'UNKNOWN';

/** A MOTO charge request as the domain understands it (no card data). */
export interface PaymentIntent {
  correlationToken: string;   // POS-minted idempotency key
  terminalId: string;
  merchantId: string;
  amountMinor: number;        // integer minor units (cents), never float
  currency: string;           // ISO-4217 alpha (e.g. "EUR")
  paymentToken: string;       // single-use Viva chargeToken from the POS tokenizer
  maskedPan: string;          // "411111****1111"
  cardBrand: CardBrand;
  /** MOTO (manual/telephone) charge -> charge the MOTO source (out of 3DS scope)
   *  when one is configured; otherwise the e-commerce source. */
  moto?: boolean;
}

/** Provider-agnostic acquiring error taxonomy. */
export type AcquiringErrorCode =
  | 'INSUFFICIENT_FUNDS'
  | 'INVALID_CARD'
  | 'EXPIRED_CARD'
  | 'DO_NOT_HONOR'
  | 'CARD_DECLINED'
  | 'FRAUD_SUSPECTED'
  | 'INVALID_AMOUNT'
  | 'DUPLICATE_TRANSACTION'
  | 'GATEWAY_TIMEOUT'
  | 'GATEWAY_ERROR'
  | 'CONFIGURATION_ERROR'
  | 'UNKNOWN';

export interface AcquiringError {
  code: AcquiringErrorCode;
  message: string;
  /** raw provider indicator for the error_log (never card data). */
  providerCode?: string;
  /** whether the same correlation_token may be safely retried. */
  retriable: boolean;
}

/** Outcome of charging at the acquirer (provider-agnostic). */
export interface ChargeOutcome {
  approved: boolean;
  vivaTransactionId?: string;
  vivaOrderCode?: string;
  authorizationCode?: string;
  error?: AcquiringError;
}

/** The persisted ledger record — mirrors `fiat_transaction_log` (010 migration). */
export interface TransactionRecord {
  id: string;
  correlationToken: string;
  terminalId: string;
  merchantId: string;
  amountMinor: number;
  currency: string;
  maskedPan: string;
  cardBrand: CardBrand;
  vivaTransactionId: string | null;
  vivaOrderCode: string | null;
  authorizationCode: string | null;
  errorLog: Record<string, unknown> | null;
  status: FiatStatus;
  createdAt: string;
  updatedAt: string;
}

/** Thrown by a LedgerRepository when correlation_token already exists (idempotency). */
export class DuplicateCorrelationError extends Error {
  constructor(public readonly correlationToken: string) {
    super(`duplicate correlation_token: ${correlationToken}`);
    this.name = 'DuplicateCorrelationError';
  }
}
