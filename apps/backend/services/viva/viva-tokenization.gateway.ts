/**
 * PROJECT TITAN — Viva tokenization gateway (DRIVEN/infrastructure).
 *
 * POSTs the PAX P2PE ciphertext + KSN to Viva's card-tokenization endpoint and
 * returns a single-use chargeToken. Auth is the injected AuthHeaderProvider — the
 * SAME strategy as the charge adapter — so tokenize + charge use one scheme
 * (Basic on accounts where the OAuth app lacks scopes). HTTP + auth injected;
 * no secrets in code. Endpoint path/fields are Viva-account specific; the port +
 * mapping are stable regardless.
 */
import { HttpClient } from './viva.adapter';
import { AuthHeaderProvider } from './viva-auth';
import { TokenizationGateway, TokenizeOutcome, EncryptedCardPayload } from './tokenization';
import { transportError, classifyDeclineError } from './error-map';

export interface VivaTokenizationConfig {
  baseUrl: string;        // e.g. https://api.vivapayments.com
  tokenizePath: string;   // e.g. /acquiring/v1/cards/tokens
}

export class VivaTokenizationGateway implements TokenizationGateway {
  constructor(
    private readonly http: HttpClient,
    private readonly auth: AuthHeaderProvider,
    private readonly cfg: VivaTokenizationConfig,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async tokenize(payload: EncryptedCardPayload, correlationToken: string): Promise<TokenizeOutcome> {
    let authorization: string;
    try {
      authorization = await this.auth.authHeader();
    } catch {
      return { ok: false, error: { code: 'CONFIGURATION_ERROR', message: 'could not obtain Viva authorization', retriable: true } };
    }

    let res;
    try {
      res = await this.http.post(
        `${this.cfg.baseUrl}${this.cfg.tokenizePath}`,
        {
          ksn: payload.ksn,
          encryptedData: payload.encryptedPayload,
          merchantTrns: correlationToken,
        },
        {
          Authorization: authorization,   // "Basic …" or "Bearer …" per the auth strategy
          'Content-Type': 'application/json',
          'Idempotency-Key': correlationToken,
        },
      );
    } catch {
      return { ok: false, error: { code: 'GATEWAY_TIMEOUT', message: 'no response from Viva tokenization', providerCode: 'NETWORK', retriable: true } };
    }

    const te = transportError(res.status);
    if (te) return { ok: false, error: te };

    const token =
      res.body?.token ?? res.body?.chargeToken ?? res.body?.Token ?? res.body?.ChargeToken;
    if (res.status >= 200 && res.status < 300 && token) {
      const expiresInSec = Number(res.body?.expiresIn ?? res.body?.expires_in ?? 3600);
      return {
        ok: true,
        chargeToken: String(token),
        expiresAtMs: this.now() + expiresInSec * 1000,
        maskedPan: payload.maskedPan,
        cardBrand: payload.cardBrand,
      };
    }

    return { ok: false, error: classifyDeclineError(res.body) };
  }
}
