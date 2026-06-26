/**
 * PROJECT TITAN — Viva Wallet OAuth2 token provider (client-credentials + cache).
 *
 * Viva's modern API authenticates with an OAuth2 client-credentials grant against
 * the accounts host (https://demo-accounts.viva.com/connect/token in demo). We
 * exchange Basic(client_id:client_secret) for a bearer access_token and CACHE it
 * until shortly before `expires_in`, so we don't mint a token per charge. HTTP is
 * injected so this is unit-testable without network, and the client secret stays
 * out of logs.
 */
import { VivaTokenProvider } from './viva.adapter';

/** Low-level form-POST surface (Basic auth + x-www-form-urlencoded). */
export interface TokenHttp {
  postForm(url: string, headers: Record<string, string>, form: Record<string, string>): Promise<{ status: number; body: any }>;
}

export interface VivaOAuthConfig {
  accountsUrl: string;   // e.g. https://demo-accounts.viva.com/connect/token
  clientId: string;
  clientSecret: string;
}

export class VivaOAuthTokenProvider implements VivaTokenProvider {
  private cached: { token: string; expiresAtMs: number } | null = null;

  constructor(
    private readonly http: TokenHttp,
    private readonly cfg: VivaOAuthConfig,
    private readonly now: () => number = () => Date.now(),
    /** refresh this many ms BEFORE expiry to avoid using a just-expired token. */
    private readonly skewMs = 30_000,
  ) {}

  async accessToken(): Promise<string> {
    if (this.cached && this.cached.expiresAtMs - this.skewMs > this.now()) {
      return this.cached.token; // cache hit
    }
    const basic = Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString('base64');
    const res = await this.http.postForm(
      this.cfg.accountsUrl,
      { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      { grant_type: 'client_credentials' },
    );
    const token = res.body?.access_token;
    if (res.status < 200 || res.status >= 300 || !token) {
      this.cached = null;
      throw new Error(`Viva OAuth token request failed (status ${res.status})`);
    }
    const expiresInSec = Number(res.body.expires_in ?? 3600);
    this.cached = { token, expiresAtMs: this.now() + expiresInSec * 1000 };
    return token;
  }
}

/** Default {@link TokenHttp} over global fetch (Node 18+). */
export class FetchTokenHttp implements TokenHttp {
  constructor(private readonly timeoutMs = 10_000) {}
  async postForm(url: string, headers: Record<string, string>, form: Record<string, string>) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: new URLSearchParams(form).toString(),
        signal: ctrl.signal,
      });
      const body = await res.json().catch(() => ({}));
      return { status: res.status, body };
    } finally {
      clearTimeout(t);
    }
  }
}
