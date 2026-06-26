/**
 * PROJECT TITAN — Viva OAuth token provider: caching + client-credentials.
 */
import { VivaOAuthTokenProvider, TokenHttp } from '../services/viva/viva-token-provider';

function fakeHttp(token = 'tok_abc', expiresIn = 3600, status = 200) {
  const calls: Array<{ url: string; headers: Record<string, string>; form: Record<string, string> }> = [];
  const http: TokenHttp = {
    async postForm(url, headers, form) {
      calls.push({ url, headers, form });
      return { status, body: status === 200 ? { access_token: token, expires_in: expiresIn, token_type: 'Bearer' } : {} };
    },
  };
  return { http, calls };
}

const cfg = { accountsUrl: 'https://demo-accounts.viva.com/connect/token', clientId: 'cid', clientSecret: 'sec' };

describe('VivaOAuthTokenProvider', () => {
  it('caches the token within its lifetime (one network call for repeated requests)', async () => {
    const { http, calls } = fakeHttp('t1', 3600);
    let now = 1_000_000;
    const p = new VivaOAuthTokenProvider(http, cfg, () => now);
    expect(await p.accessToken()).toBe('t1');
    now += 60_000; // 1 min later, well within the 1h lifetime
    expect(await p.accessToken()).toBe('t1');
    expect(calls).toHaveLength(1); // served from cache
  });

  it('refetches after expiry (minus skew)', async () => {
    const { http, calls } = fakeHttp('t1', 100); // 100s lifetime
    let now = 0;
    const p = new VivaOAuthTokenProvider(http, cfg, () => now, 30_000);
    await p.accessToken();
    now = 80_000; // past (100s - 30s skew = 70s) -> must refetch
    await p.accessToken();
    expect(calls).toHaveLength(2);
  });

  it('sends Basic client_id:client_secret and the client_credentials grant', async () => {
    const { http, calls } = fakeHttp();
    const p = new VivaOAuthTokenProvider(http, cfg, () => 0);
    await p.accessToken();
    expect(calls[0].headers.Authorization).toBe('Basic ' + Buffer.from('cid:sec').toString('base64'));
    expect(calls[0].headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(calls[0].form.grant_type).toBe('client_credentials');
  });

  it('throws on a non-2xx token response (adapter maps this to CONFIGURATION_ERROR)', async () => {
    const { http } = fakeHttp('x', 3600, 401);
    const p = new VivaOAuthTokenProvider(http, cfg, () => 0);
    await expect(p.accessToken()).rejects.toThrow();
  });
});
