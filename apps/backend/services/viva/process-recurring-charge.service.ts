/**
 * PROJECT TITAN — ProcessRecurringCharge use-case (APPLICATION layer).
 *
 * Orchestrates one merchant-initiated (no-OTP) charge: idempotency check ->
 * RECURRING_CREATED -> charge via the recurring gateway -> APPROVED|DECLINED.
 * Idempotency is enforced two ways (up-front lookup + unique-correlation catch),
 * so a retried correlation_token NEVER double-charges the cardholder.
 */
import { RecurringRepository, RecurringChargeRecord } from './recurring.store';
import { VivaRecurringGateway } from './viva-recurring.gateway';
import { ChargeOutcome, DuplicateCorrelationError } from './domain';

export interface RecurringChargeInput {
  correlationToken: string;
  terminalId: string;
  merchantId: string;
  initialTransactionId: string;
  amountMinor: number;
  currency: string;
  customerTrns?: string;
}

export class ProcessRecurringChargeService {
  constructor(
    private readonly gateway: VivaRecurringGateway,
    private readonly repo: RecurringRepository,
  ) {}

  async process(input: RecurringChargeInput): Promise<RecurringChargeRecord> {
    const existing = await this.repo.findByCorrelationToken(input.correlationToken);
    if (existing) return existing;

    let record: RecurringChargeRecord;
    try {
      record = await this.repo.create({
        correlationToken: input.correlationToken,
        terminalId: input.terminalId,
        merchantId: input.merchantId,
        initialTransactionId: input.initialTransactionId,
        amountMinor: input.amountMinor,
        currency: input.currency,
      });
    } catch (e) {
      if (e instanceof DuplicateCorrelationError) {
        const winner = await this.repo.findByCorrelationToken(input.correlationToken);
        if (winner) return winner;
      }
      throw e;
    }

    let outcome: ChargeOutcome;
    try {
      outcome = await this.gateway.charge({
        initialTransactionId: input.initialTransactionId,
        amountMinor: input.amountMinor,
        correlationToken: input.correlationToken,
        customerTrns: input.customerTrns,
      });
    } catch (e) {
      outcome = { approved: false, error: { code: 'GATEWAY_ERROR', message: `gateway threw: ${String(e)}`, retriable: true } };
    }

    if (outcome.approved) {
      return this.repo.updateStatus(record.id, {
        status: 'RECURRING_APPROVED',
        vivaTransactionId: outcome.vivaTransactionId ?? null,
      });
    }

    // CRITICAL: distinguish a DEFINITE decline (known not-charged) from an
    // INDETERMINATE transport failure (timeout / 5xx). On an indeterminate outcome
    // the card MAY already have been charged at Viva, so writing a terminal DECLINED
    // would let the operator re-ring and double-charge. Park such rows as PROCESSING
    // (non-terminal) — they must be reconciled out-of-band (Viva dashboard) before any
    // retry. Only a definite decline (StatusId 'E' / 4xx, retriable === false) is final.
    const indeterminate = outcome.error?.retriable === true;
    if (indeterminate) {
      return this.repo.updateStatus(record.id, {
        status: 'RECURRING_PROCESSING',
        errorLog: {
          code: outcome.error?.code ?? 'UNKNOWN',
          message: outcome.error?.message ?? 'indeterminate outcome',
          indeterminate: true,
        },
      });
    }

    return this.repo.updateStatus(record.id, {
      status: 'RECURRING_DECLINED',
      vivaTransactionId: outcome.vivaTransactionId ?? null,
      errorLog: outcome.error
        ? { code: outcome.error.code, message: outcome.error.message, providerCode: outcome.error.providerCode ?? null }
        : { code: 'UNKNOWN', message: 'no outcome returned' },
    });
  }
}
