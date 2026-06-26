/**
 * PROJECT TITAN — Viva READ-ONLY probe of the legacy Basic-auth retrieval API.
 *
 * Viva serves several /api/... retrieval endpoints with Basic auth
 * (Merchant ID : API Key) rather than OAuth. This GETs a RANDOM (non-existent)
 * transaction id with Basic auth — no charge, no creation, no money:
 *   401 -> Basic credentials REJECTED
 *   403 -> accepted, lacks permission (auth OK)
 *   404 -> accepted, auth + base URL OK, not found  <-- ideal
 *
 * Run: VIVA_ALLOW_LIVE=yes node --env-file=.env apps/backend/scripts/viva-probe-basic.mjs
 */
import { randomUUID } from 'crypto';

const baseUrl = process.env.VIVA_BASE_URL || 'https://demo-api.vivapayments.com';
const merchantId = process.env.VIVA_MERCHANT_ID || '';
const apiKey = process.env.VIVA_API_KEY || '';

if (!merchantId || !apiKey) { console.error('Missing VIVA_MERCHANT_ID / VIVA_API_KEY'); process.exit(2); }
if (!/demo[-.]/i.test(baseUrl) && process.env.VIVA_ALLOW_LIVE !== 'yes') {
  console.error(`Refusing non-demo host ${baseUrl}. Set VIVA_ALLOW_LIVE=yes to override.`);
  process.exit(3);
}

const basic = Buffer.from(`${merchantId}:${apiKey}`).toString('base64');
const url = `${baseUrl}/api/transactions/${randomUUID()}`;
const res = await fetch(url, { method: 'GET', headers: { Authorization: `Basic ${basic}` } });

let verdict;
if (res.status === 401) verdict = 'Basic credentials REJECTED';
else if (res.status === 403) verdict = 'accepted; lacks permission (auth OK)';
else if (res.status === 404) verdict = 'accepted; auth + base URL OK (not found, as expected)';
else verdict = `accepted (unexpected status ${res.status})`;

console.log(`BASIC  host=${new URL(baseUrl).host}  GET /api/transactions/<random>  status=${res.status}  -> ${verdict}`);
process.exit(res.status === 401 ? 1 : 0);
