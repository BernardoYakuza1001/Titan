/**
 * PROJECT TITAN — Viva connectivity smoke check.
 *
 * Performs ONLY an OAuth2 client-credentials token fetch — it does NOT charge,
 * tokenize, or move any money. Use it to confirm your credentials + network
 * reach Viva before wiring the app.
 *
 * Run (with DEMO credentials in .env):
 *   node --env-file=.env apps/backend/scripts/viva-smoke.mjs
 *
 * It REFUSES non-demo hosts unless you explicitly set VIVA_ALLOW_LIVE=yes, so it
 * can't accidentally authenticate against your live account. Secrets and the
 * returned token are never printed.
 */
const accountsUrl = process.env.VIVA_ACCOUNTS_URL || 'https://demo-accounts.vivapayments.com/connect/token';
const clientId = process.env.VIVA_CLIENT_ID || '';
const clientSecret = process.env.VIVA_CLIENT_SECRET || '';

if (!clientId || !clientSecret) {
  console.error('Missing VIVA_CLIENT_ID / VIVA_CLIENT_SECRET in env.');
  process.exit(2);
}

const isDemo = /demo[-.]/i.test(accountsUrl);
if (!isDemo && process.env.VIVA_ALLOW_LIVE !== 'yes') {
  console.error(`Refusing to authenticate against a NON-DEMO host: ${accountsUrl}`);
  console.error('Validate against demo first. To override (not recommended), set VIVA_ALLOW_LIVE=yes.');
  process.exit(3);
}

const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

try {
  const res = await fetch(accountsUrl, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const body = await res.json().catch(() => ({}));
  if (res.ok && body.access_token) {
    console.log(
      `OK   host=${new URL(accountsUrl).host}  status=${res.status}  ` +
      `access_token.len=${String(body.access_token).length}  expires_in=${body.expires_in}`,
    );
    process.exit(0);
  }
  console.error(`FAIL host=${new URL(accountsUrl).host}  status=${res.status}  error=${body.error ?? JSON.stringify(body).slice(0, 200)}`);
  process.exit(1);
} catch (e) {
  console.error(`FAIL network/TLS error: ${e.message}`);
  process.exit(1);
}
