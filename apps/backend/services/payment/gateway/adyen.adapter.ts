/**
 * PROJECT TITAN — Adyen gateway adapter (Phase 4)
 *
 * Translates the normalized gateway contract to Adyen's Checkout/Payments API.
 * Real request shapes shown; the API key + HMAC live in Vault/HSM and are passed
 * in, never hardcoded. Network is injected (HttpClient) so this is testable.
 *
 * Decline mapping: Adyen `refusalReason`/`resultCode` -> normalized reason codes
 * so the router's success-rate logic and the saga see processor-agnostic values.
 */
import {
  PaymentGatewayAdapter, AuthorizeRequest, VoidRequest, GatewayResult, HttpClient,
} from './payment-gateway.port';

const NORMALIZED_DECLINE: Record<string, string> = {
  'Refused': 'DECLINED_GENERIC',
  'Insufficient balance': 'INSUFFICIENT_FUNDS',
  'Expired Card': 'CARD_EXPIRED',
  'FRAUD': 'SUSPECTED_FRAUD',
  'FRAUD-CANCELLED': 'SUSPECTED_FRAUD',
  'Acquirer Fraud': 'SUSPECTED_FRAUD',
  '3D Not Authenticated': 'AUTH_FAILED',
};

export class AdyenAdapter implements PaymentGatewayAdapter {
  readonly processor = 'adyen';

  constructor(
    private readonly http: HttpClient,
    private readonly baseUrl: string,        // e.g. https://{prefix}-checkout-live.adyenpayments.com/v71
    private readonly apiKey: () => string,   // resolved from Vault per-call (short-lived)
  ) {}

  async authorize(req: AuthorizeRequest): Promise<GatewayResult> {
    const res = await this.http.post(
      `${this.baseUrl}/payments`,
      {
        merchantAccount: req.route.merchantAccount,
        amount: { value: req.amountMinor, currency: req.currency },
        paymentMethod: { type: 'networkToken', storedPaymentMethodId: req.cardToken },
        reference: req.reference,
        // preAuth => manual capture (hold). auth+capture => automatic.
        captureDelayHours: req.preAuth ? undefined : 0,
        additionalData: { manualCapture: req.preAuth ? 'true' : 'false' },
      },
      {
        'X-API-Key': this.apiKey(),
        'Content-Type': 'application/json',
        // Adyen honors Idempotency-Key — replays return the original result.
        'Idempotency-Key': req.idempotencyKey,
      },
    );

    const body = res.body ?? {};
    if (res.status >= 200 && res.status < 300 && body.resultCode === 'Authorised') {
      return { ok: true, authCode: body.authCode, networkRef: body.pspReference, raw: body };
    }
    const reason = NORMALIZED_DECLINE[body.refusalReason] ?? body.refusalReason ?? 'DECLINED_GENERIC';
    return { ok: false, reason, networkRef: body.pspReference, raw: body };
  }

  async void(req: VoidRequest): Promise<GatewayResult> {
    const res = await this.http.post(
      `${this.baseUrl}/payments/${req.networkRef}/cancels`,
      { merchantAccount: req.route.merchantAccount, reference: `${req.reference}-void` },
      {
        'X-API-Key': this.apiKey(),
        'Content-Type': 'application/json',
        'Idempotency-Key': `${req.idempotencyKey}-void`,
      },
    );
    const body = res.body ?? {};
    const ok = res.status >= 200 && res.status < 300 && body.status === 'received';
    return { ok, networkRef: body.pspReference, raw: body };
  }
}
