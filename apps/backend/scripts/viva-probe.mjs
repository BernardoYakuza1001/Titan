/**
 * PROJECT TITAN — Viva READ-ONLY API reachability probe.
 *
 * 1) OAuth2 client-credentials token fetch.
 * 2) An authenticated GET for a RANDOM (non-existent) transaction id.
 *
 * It NEVER charges, tokenizes, or creates anything. The only goal is to confirm
 * the bearer token is accepted by the API host (base URL + auth + scope):
 *    401 -> token REJECTED (problem)
 *    403 -> token accepted, lacks permission for this resource (still: auth OK)
 *    404 -> token accepted, base URL + auth OK, resource simply not found  <-- ideal
 *
 * Run: VIVA_ALLOW_LIVE=yes node --env-file=.env apps/backend/scripts/viva-probe.mjs
 */
import { randomUUID } from 'crypto';

const accountsUrl = process.env.VIVA_ACCOUNTS_URL || 'https://demo-accounts.vivapayments.com/connect/token';
const baseUrl = process.env.VIVA_BASE_URL || 'https://demo-api.vivapayments.com';
const txPath = process.env.VIVA_TRANSACTIONS_PATH || '/checkout/v2/transactions';
const clientId = process.env.VIVA_CLIENT_ID || '';
const clientSecret = process.env.VIVA_CLIENT_SECRET || '';

if (!clientId || !clientSecret) { console.error('Missing VIVA_CLIENT_ID / VIVA_CLIENT_SECRET'); process.exit(2); }
if (!/demo[-.]/i.test(accountsUrl) && process.env.VIVA_ALLOW_LIVE !== 'yes') {
  console.error(`Refusing non-demo host ${accountsUrl}. Set VIVA_ALLOW_LIVE=yes to override.`);
  process.exit(3);
}

const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

const tokenRes = await fetch(accountsUrl, {
  method: 'POST',
  headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
  body: 'grant_type=client_credentials',
});
const tokenBody = await tokenRes.json().catch(() => ({}));
if (!tokenRes.ok || !tokenBody.access_token) {
  console.error(`OAUTH FAIL status=${tokenRes.status} error=${tokenBody.error ?? ''}`);
  process.exit(1);
}
console.log(`OAUTH  OK   status=${tokenRes.status}  expires_in=${tokenBody.expires_in}`);

const probeUrl = `${baseUrl}${txPath}/${randomUUID()}`;
const apiRes = await fetch(probeUrl, { method: 'GET', headers: { Authorization: `Bearer ${tokenBody.access_token}` } });

let verdict;
if (apiRes.status === 401) verdict = 'token REJECTED (auth/scope problem)';
else if (apiRes.status === 403) verdict = 'token accepted; lacks permission for this resource (auth OK)';
else if (apiRes.status === 404) verdict = 'token accepted; base URL + auth OK (resource not found, as expected)';
else verdict = `token accepted (unexpected status ${apiRes.status})`;

console.log(`API    host=${new URL(baseUrl).host}  GET ${txPath}/<random>  status=${apiRes.status}  -> ${verdict}`);
process.exit(apiRes.status === 401 ? 1 : 0);
