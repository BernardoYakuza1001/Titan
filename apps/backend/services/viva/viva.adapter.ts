/**
 * PROJECT TITAN — Viva Wallet acquiring adapter (DRIVEN/infrastructure).
 *
 * Implements AcquiringGateway by charging the POS-supplied single-use chargeToken
 * via Viva Wallet's MOTO / card-not-present transaction endpoint. HTTP + OAuth are
 * injected ports, so the adapter is unit-testable without network, and the secret
 * credentials never live in this file.
 *
 * Endpoint/field shapes follow Viva's transactions API; the exact path + auth are
 * config so you can point at demo (https://demo-api.viva.com) or live
 * (https://api.viva.com). Idempotency is asserted with the correlation_token both
 * as the Idempotency-Key header and as merchantTrns.
 */
import { AcquiringGateway } from './ports';
import { PaymentIntent, ChargeOutcome } from './domain';
import { mapVivaResponse, VivaHttpResponse } from './error-map';
import { AuthHeaderProvider } from './viva-auth';

export interface HttpClient {
  post(url: string, body: unknown, headers: Record<string, string>): Promise<VivaHttpResponse>;
}

/** Supplies a short-lived OAuth2 bearer token (client-credentials), cached/refreshed elsewhere. */
export interface VivaTokenProvider {
  accessToken(): Promise<string>;
}

export interface VivaConfig {
  baseUrl: string;          // e.g. https://api.vivapayments.com
  transactionsPath: string; // OAuth: /checkout/v2/transactions | Basic: /nativecheckout/v2/transactions
  sourceCode: string;       // Viva payment source code
  /**
   * Send `currencyCode` in the body. OAuth /checkout expects it; Native Checkout
   * derives the currency from the source, so send `false` there to avoid a 400.
   */
  sendCurrencyCode?: boolean;
}

/** ISO-4217 alpha -> numeric, as Viva expects (978=EUR, 840=USD, 826=GBP). */
const CURRENCY_NUMERIC: Record<string, number> = { EUR: 978, USD: 840, GBP: 826 };

export class VivaWalletAcquiringAdapter implements AcquiringGateway {
  constructor(
    private readonly http: HttpClient,
    private readonly auth: AuthHeaderProvider,
    private readonly cfg: VivaConfig,
  ) {}

  async charge(intent: PaymentIntent): Promise<ChargeOutcome> {
    const currencyCode = CURRENCY_NUMERIC[intent.currency];
    if (currencyCode === undefined) {
      return {
        approved: false,
        error: { code: 'INVALID_AMOUNT', message: `unsupported currency ${intent.currency}`, retriable: false },
      };
    }

    let authorization: string;
    try {
      authorization = await this.auth.authHeader();
    } catch {
      return { approved: false, error: { code: 'CONFIGURATION_ERROR', message: 'could not obtain Viva authorization', retriable: true } };
    }

    const body: Record<string, unknown> = {
      amount: intent.amountMinor,        // Viva expects integer minor units
      chargeToken: intent.paymentToken,  // single-use token from the POS tokenizer (MOTO)
      sourceCode: this.cfg.sourceCode,
      merchantTrns: intent.correlationToken,           // our reference / idempotency
      customerTrns: `Terminal ${intent.terminalId}`,
    };
    if (this.cfg.sendCurrencyCode !== false) body.currencyCode = currencyCode;

    let res: VivaHttpResponse;
    try {
      res = await this.http.post(
        `${this.cfg.baseUrl}${this.cfg.transactionsPath}`,
        body,
        {
          Authorization: authorization,   // "Bearer …" or "Basic …" per the auth strategy
          'Content-Type': 'application/json',
          'Idempotency-Key': intent.correlationToken,
        },
      );
    } catch {
      // no response at all (DNS/socket/timeout) — treat as a gateway timeout, retriable.
      return { approved: false, error: { code: 'GATEWAY_TIMEOUT', message: 'no response from Viva', providerCode: 'NETWORK', retriable: true } };
    }

    return mapVivaResponse(res);
  }
}
