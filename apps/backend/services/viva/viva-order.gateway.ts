/**
 * PROJECT TITAN — Viva order gateway (DRIVEN/infrastructure).
 * Creates a hosted-checkout order via Viva's Basic-auth orders API and returns the
 * orderCode + the hosted checkout URL. HTTP + auth injected (testable).
 */
import { HttpClient } from './viva.adapter';
import { AuthHeaderProvider } from './viva-auth';
import { CheckoutOrderGateway, CheckoutOrderRequest, CreateOrderOutcome } from './checkout';
import { transportError, classifyDeclineError } from './error-map';

export interface VivaOrderConfig {
  ordersUrl: string;     // e.g. https://www.vivapayments.com/api/orders (live) / demo.vivapayments.com
  checkoutUrl: string;   // e.g. https://www.vivapayments.com/web/checkout (live)
  sourceCode: string;
}

export class VivaOrderGateway implements CheckoutOrderGateway {
  constructor(
    private readonly http: HttpClient,
    private readonly auth: AuthHeaderProvider,
    private readonly cfg: VivaOrderConfig,
  ) {}

  async createOrder(req: CheckoutOrderRequest): Promise<CreateOrderOutcome> {
    let authorization: string;
    try {
      authorization = await this.auth.authHeader();
    } catch {
      return { ok: false, error: { code: 'CONFIGURATION_ERROR', message: 'could not obtain Viva authorization', retriable: true } };
    }

    let res;
    try {
      res = await this.http.post(
        this.cfg.ordersUrl,
        {
          Amount: req.amountMinor,            // integer minor units (cents)
          SourceCode: this.cfg.sourceCode,
          MerchantTrns: req.correlationToken,
          CustomerTrns: req.customerTrns ?? `Terminal ${req.terminalId}`,
        },
        {
          Authorization: authorization,       // "Basic …"
          'Content-Type': 'application/json',
          'Idempotency-Key': req.correlationToken,
        },
      );
    } catch {
      return { ok: false, error: { code: 'GATEWAY_TIMEOUT', message: 'no response from Viva orders', providerCode: 'NETWORK', retriable: true } };
    }

    const te = transportError(res.status);
    if (te) return { ok: false, error: te };

    const orderCode = res.body?.OrderCode ?? res.body?.orderCode;
    if (res.status >= 200 && res.status < 300 && orderCode != null) {
      const code = String(orderCode);
      return { ok: true, orderCode: code, checkoutUrl: `${this.cfg.checkoutUrl}?ref=${code}` };
    }

    return { ok: false, error: classifyDeclineError(res.body) };
  }
}
