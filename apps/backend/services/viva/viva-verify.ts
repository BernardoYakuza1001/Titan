/**
 * PROJECT TITAN — Viva read-side client used to CONFIRM hosted-checkout payments.
 *
 * Viva webhooks are not signed, so we never trust a webhook body. Instead we use
 * OUR OWN credentials to (a) fetch the webhook verification token for the GET
 * handshake, and (b) look the transaction up directly on Viva's transactions API
 * and match it against the order we created. A spoofed POST cannot fabricate a
 * real transaction in our account that matches order code + amount + status.
 */
import { VivaHttpResponse } from './error-map';
import { AuthHeaderProvider } from './viva-auth';

/** GET half of the Viva HTTP surface (the charge path only needs POST). */
export interface HttpGetClient {
  get(url: string, headers: Record<string, string>): Promise<VivaHttpResponse>;
}

export interface VivaTransactionDetails {
  transactionId: string;
  orderCode: string | null;
  statusId: string;            // 'F' = finished/captured (success)
  amountMajor: number | null;  // this API returns Amount in MAJOR units (e.g. 1.00)
  currencyCode: string | null; // ISO-4217 numeric as a string (e.g. "978")
}

export interface VivaVerifyConfig {
  wwwBaseUrl: string;           // https://www.vivapayments.com
  staticWebhookToken?: string;  // optional override; otherwise fetched from Viva
}

export class VivaTransactionVerifier {
  /** The verification token is stable per account; cache it so the public GET
   *  handshake cannot drive an unbounded number of credentialed calls to Viva. */
  private cachedToken: string | null = null;

  constructor(
    private readonly http: HttpGetClient,
    private readonly auth: AuthHeaderProvider,
    private readonly cfg: VivaVerifyConfig,
  ) {}

  /** The token Viva expects echoed back on the webhook verification GET. */
  async getWebhookToken(): Promise<string> {
    if (this.cfg.staticWebhookToken) return this.cfg.staticWebhookToken;
    if (this.cachedToken) return this.cachedToken;
    const authorization = await this.auth.authHeader();
    const res = await this.http.get(`${this.cfg.wwwBaseUrl}/api/messages/config/token`, {
      Authorization: authorization,
      'Content-Type': 'application/json',
    });
    const key = res.body?.Key ?? res.body?.key;
    if (res.status >= 200 && res.status < 300 && key) {
      this.cachedToken = String(key);
      return this.cachedToken;
    }
    throw new Error(`could not fetch Viva webhook token (status ${res.status})`);
  }

  /** Look up a transaction directly. Returns null on any non-success / network error. */
  async getTransaction(transactionId: string): Promise<VivaTransactionDetails | null> {
    let authorization: string;
    try {
      authorization = await this.auth.authHeader();
    } catch {
      return null;
    }
    let res: VivaHttpResponse;
    try {
      res = await this.http.get(
        `${this.cfg.wwwBaseUrl}/api/transactions/${encodeURIComponent(transactionId)}`,
        { Authorization: authorization, 'Content-Type': 'application/json' },
      );
    } catch {
      return null;
    }
    if (res.status < 200 || res.status >= 300) return null;

    const body = res.body ?? {};
    // /api/transactions/{id} returns { Transactions: [ {...} ] } (HTTP 200 even when
    // NOT FOUND — empty array + ErrorCode 404) or, on some APIs, a flat object.
    const arr = body.Transactions ?? body.transactions;
    let t: any;
    if (Array.isArray(arr)) {
      if (arr.length === 0) return null;   // transaction not found
      t = arr[0];
    } else {
      t = body;
    }

    const statusId = String(t.StatusId ?? t.statusId ?? '');
    const orderCode = t.OrderCode ?? t.orderCode;
    const amount = t.Amount ?? t.amount;
    const currencyCode = t.CurrencyCode ?? t.currencyCode;

    return {
      transactionId,
      orderCode: orderCode == null ? null : String(orderCode),
      statusId,
      amountMajor: amount == null || amount === '' ? null : Number(amount),
      currencyCode: currencyCode == null ? null : String(currencyCode),
    };
  }
}
