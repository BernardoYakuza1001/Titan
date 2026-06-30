/**
 * PROJECT TITAN — Viva recurring (MIT) charge gateway (DRIVEN/infrastructure).
 *
 * Charges a cardholder again WITHOUT 3DS/OTP by chaining off the initial
 * authenticated transaction id: POST {www}/api/transactions/{initialTransactionId}
 * over Basic auth. No customer present, no card data. (Requires the account's
 * self-service "Allow recurring payments … via API" setting; the initial order
 * must have been created with AllowRecurring=true and authenticated once.)
 */
import { HttpClient } from './viva.adapter';
import { AuthHeaderProvider } from './viva-auth';
import { ChargeOutcome } from './domain';
import { mapVivaResponse } from './error-map';
import { numericCode } from './currency';

export interface RecurringChargeRequest {
  initialTransactionId: string;
  amountMinor: number;
  currency: string;
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
    const numeric = numericCode(req.currency);
    if (numeric == null) {
      return { approved: false, error: { code: 'INVALID_AMOUNT', message: `unsupported currency ${req.currency}`, retriable: false } };
    }

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
          amount: req.amountMinor,           // integer minor units
          currencyCode: Number(numeric),     // ISO-4217 numeric
          customerTrns: req.customerTrns ?? 'Recurring charge',
          merchantTrns: req.correlationToken,
          sourceCode: this.cfg.sourceCode,
        },
        {
          Authorization: authorization,      // "Basic …"
          'Content-Type': 'application/json',
          'Idempotency-Key': req.correlationToken,
        },
      );
    } catch {
      return { approved: false, error: { code: 'GATEWAY_TIMEOUT', message: 'no response from Viva', providerCode: 'NETWORK', retriable: true } };
    }

    return mapVivaResponse(res);
  }
}
