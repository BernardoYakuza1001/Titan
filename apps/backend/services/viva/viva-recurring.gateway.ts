/**
 * PROJECT TITAN — Viva recurring (MIT) charge gateway (DRIVEN/infrastructure).
 *
 * Charges a cardholder again WITHOUT 3DS/OTP by chaining off the initial
 * authenticated transaction id: POST {www}/api/transactions/{initialTransactionId}
 * over Basic auth. No customer present, no card data.
 *
 * NOTE: the recurring endpoint has NO currencyCode field — Viva inherits the
 * currency from the anchor transaction (you cannot override it), so we deliberately
 * do not send one. (Sending a caller-supplied currency would, at best, be ignored
 * and, at worst, surface as an opaque soft-200 decline.)
 */
import { HttpClient } from './viva.adapter';
import { AuthHeaderProvider } from './viva-auth';
import { ChargeOutcome } from './domain';
import { mapVivaResponse } from './error-map';

export interface RecurringChargeRequest {
  initialTransactionId: string;
  amountMinor: number;
  correlationToken: string;
  customerTrns?: string;
}

export interface VivaRecurringConfig {
  wwwBaseUrl: string;   // https://www.vivapayments.com
  sourceCode: string;
}

export class VivaRecurringGateway {
  constructor(
    private readonly http: HttpClient,
    private readonly auth: AuthHeaderProvider,
    private readonly cfg: VivaRecurringConfig,
  ) {}

  async charge(req: RecurringChargeRequest): Promise<ChargeOutcome> {
    let authorization: string;
    try {
      authorization = await this.auth.authHeader();
    } catch {
      return { approved: false, error: { code: 'CONFIGURATION_ERROR', message: 'could not obtain Viva authorization', retriable: true } };
    }

    let res;
    try {
      res = await this.http.post(
        `${this.cfg.wwwBaseUrl}/api/transactions/${encodeURIComponent(req.initialTransactionId)}`,
        {
          amount: req.amountMinor,            // integer minor units; currency inherited from the anchor
          customerTrns: req.customerTrns ?? 'Recurring charge',
          merchantTrns: req.correlationToken,
          sourceCode: this.cfg.sourceCode,
        },
        {
          Authorization: authorization,       // "Basic …"
          'Content-Type': 'application/json',
          'Idempotency-Key': req.correlationToken,
        },
      );
    } catch {
      // No response at all (socket/timeout): the charge MAY have reached Viva. This
      // is INDETERMINATE (retriable) — the use-case must NOT treat it as a decline.
      return { approved: false, error: { code: 'GATEWAY_TIMEOUT', message: 'no response from Viva', providerCode: 'NETWORK', retriable: true } };
    }

    return mapVivaResponse(res);
  }
}
