/**
 * PROJECT TITAN — ProcessMotoPayment use-case (APPLICATION layer).
 *
 * Orchestrates one MOTO sale across the immutable ledger and the acquirer:
 *   idempotency check -> FIAT_CREATED -> FIAT_PROCESSING -> charge -> FIAT_APPROVED|FIAT_DECLINED
 *
 * Idempotency is enforced two ways: an up-front lookup, AND a catch on the
 * ledger's unique-correlation conflict (covers the concurrent-duplicate race) —
 * so a retried/duplicated correlation_token NEVER double-charges the card.
 */
import { ProcessMotoPaymentUseCase, AcquiringGateway, LedgerRepository } from './ports';
import { PaymentIntent, TransactionRecord, ChargeOutcome, DuplicateCorrelationError } from './domain';

export class ProcessMotoPaymentService implements ProcessMotoPaymentUseCase {
  constructor(
    private readonly gateway: AcquiringGateway,
    private readonly ledger: LedgerRepository,
  ) {}

  async process(intent: PaymentIntent): Promise<TransactionRecord> {
    // 1) Fast idempotency path: a known token returns its existing record untouched.
    const existing = await this.ledger.findByCorrelationToken(intent.correlationToken);
    if (existing) return existing;

    // 2) Persist the intent as FIAT_CREATED. If a concurrent request won the race,
    //    the unique(correlation_token) constraint throws -> we return the winner's row.
    let record: TransactionRecord;
    try {
      record = await this.ledger.create({
        correlationToken: intent.correlationToken,
        terminalId: intent.terminalId,
        merchantId: intent.merchantId,
        amountMinor: intent.amountMinor,
        currency: intent.currency,
        maskedPan: intent.maskedPan,
        cardBrand: intent.cardBrand,
      });
    } catch (e) {
      if (e instanceof DuplicateCorrelationError) {
        const winner = await this.ledger.findByCorrelationToken(intent.correlationToken);
        if (winner) return winner;
      }
      throw e;
    }

    // 3) Mark processing, then charge the token at the acquirer.
    record = await this.ledger.updateStatus(record.id, { status: 'FIAT_PROCESSING' });

    let outcome: ChargeOutcome;
    try {
      outcome = await this.gateway.charge(intent);
    } catch (e) {
      outcome = {
        approved: false,
        error: { code: 'GATEWAY_ERROR', message: `gateway threw: ${String(e)}`, retriable: true },
      };
    }

    // 4) Finalize the ledger (forward-only; DB trigger also guards this).
    if (outcome.approved) {
      return this.ledger.updateStatus(record.id, {
        status: 'FIAT_APPROVED',
        vivaTransactionId: outcome.vivaTransactionId ?? null,
        vivaOrderCode: outcome.vivaOrderCode ?? null,
        authorizationCode: outcome.authorizationCode ?? null,
      });
    }
    return this.ledger.updateStatus(record.id, {
      status: 'FIAT_DECLINED',
      vivaTransactionId: outcome.vivaTransactionId ?? null,
      vivaOrderCode: outcome.vivaOrderCode ?? null,
      errorLog: outcome.error
        ? { code: outcome.error.code, message: outcome.error.message, providerCode: outcome.error.providerCode ?? null }
        : { code: 'UNKNOWN', message: 'no outcome returned' },
    });
  }
}
