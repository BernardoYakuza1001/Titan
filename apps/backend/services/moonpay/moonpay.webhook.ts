/**
 * MoonPay webhook verification (server side).
 *
 * MoonPay signs each webhook with the WEBHOOK key and sends a
 * `Moonpay-Signature-V2: t=<unix>,s=<hex-hmac>` header. The signed payload is
 * `${timestamp}.${rawRequestBody}`. We recompute the HMAC and compare in
 * constant time, and (optionally) reject stale timestamps to stop replay.
 *
 * This is how Titan learns a transaction actually completed (crypto delivered)
 * so it can finalize the ledger — driven by MoonPay, not by trusting the client.
 */
import { createHmac, timingSafeEqual } from 'crypto';

export interface WebhookVerifyOptions {
  toleranceSeconds?: number;   // reject if |now - t| exceeds this (replay guard)
  nowSeconds?: number;         // injected clock for tests
}

function parseSignatureHeader(header: string): { t?: string; s?: string } {
  const out: { t?: string; s?: string } = {};
  for (const part of header.split(',')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k === 't') out.t = v;
    if (k === 's') out.s = v;
  }
  return out;
}

export function verifyMoonPayWebhook(
  rawBody: string,
  signatureHeader: string,
  webhookKey: string,
  opts: WebhookVerifyOptions = {},
): boolean {
  const { t, s } = parseSignatureHeader(signatureHeader);
  if (!t || !s) return false;

  const expected = createHmac('sha256', webhookKey).update(`${t}.${rawBody}`).digest('hex');
  const a = Buffer.from(s, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  if (!timingSafeEqual(a, b)) return false;

  if (opts.nowSeconds != null) {
    const tolerance = opts.toleranceSeconds ?? 300;
    if (Math.abs(opts.nowSeconds - Number(t)) > tolerance) return false;
  }
  return true;
}
