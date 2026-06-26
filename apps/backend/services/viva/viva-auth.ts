/**
 * PROJECT TITAN — Viva auth strategy. The acquiring adapter is auth-agnostic; it
 * asks an AuthHeaderProvider for the Authorization header value. Two schemes:
 *   - Bearer:  OAuth2 client-credentials (modern /checkout/v2 API)
 *   - Basic:   Merchant ID : API Key     (Native Checkout /nativecheckout/v2 API)
 *
 * This lets the same charge code run over whichever scheme your Viva account is
 * provisioned for (e.g. Basic, when the OAuth app lacks charge scopes).
 */
import { VivaTokenProvider } from './viva.adapter';

export interface AuthHeaderProvider {
  /** The full `Authorization` header value, e.g. "Bearer …" or "Basic …". */
  authHeader(): Promise<string>;
}

/** OAuth2 bearer (wraps the cached client-credentials token provider). */
export class BearerAuthProvider implements AuthHeaderProvider {
  constructor(private readonly tokens: VivaTokenProvider) {}
  async authHeader(): Promise<string> {
    return `Bearer ${await this.tokens.accessToken()}`;
  }
}

/** HTTP Basic with the Merchant ID : API Key pair (Native Checkout). */
export class BasicAuthProvider implements AuthHeaderProvider {
  private readonly header: string;
  constructor(merchantId: string, apiKey: string) {
    this.header = `Basic ${Buffer.from(`${merchantId}:${apiKey}`).toString('base64')}`;
  }
  async authHeader(): Promise<string> {
    return this.header;
  }
}
