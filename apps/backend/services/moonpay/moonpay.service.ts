/**
 * PROJECT TITAN — MoonPay on-ramp integration (server side)
 *
 * MoonPay is a regulated, PCI-DSS-compliant fiat->crypto on-ramp. The terminal
 * app opens MoonPay's hosted widget; MoonPay captures the card + runs KYC and
 * delivers crypto to the customer wallet. Titan NEVER sees raw card data.
 *
 * This service runs in the BACKEND only, because it uses the MoonPay SECRET key
 * to SIGN the widget URL (so the parameters — wallet address, amount, currency —
 * cannot be tampered with in transit). The publishable key alone lives in the
 * app. Keys come from config/env, never hardcoded in committed source.
 */
import { createHmac } from 'crypto';
import { MoonPayConfig } from './moonpay.config';

const WIDGET_BASE = {
  sandbox: 'https://buy-sandbox.moonpay.com',
  production: 'https://buy.moonpay.com',
} as const;

export class MoonPayService {
  constructor(private readonly cfg: MoonPayConfig) {}

  /** HMAC-SHA256(secretKey, query) -> base64. `query` is the URL search string incl. leading '?'. */
  signQuery(query: string): string {
    return createHmac('sha256', this.cfg.secretKey).update(query).digest('base64');
  }

  /**
   * Build a signed MoonPay *buy* widget URL. The app loads this URL (or the SDK
   * is configured with these params); MoonPay then handles card entry, KYC, and
   * crypto delivery to `walletAddress`.
   *
   * `extra` carries currencyCode (crypto to deliver), walletAddress, optional
   * baseCurrencyCode/baseCurrencyAmount (fiat), redirectURL, externalCustomerId,
   * externalTransactionId (our transaction id), etc.
   */
  buildSignedBuyUrl(extra: Record<string, string>): string {
    const base = WIDGET_BASE[this.cfg.environment];
    const usp = new URLSearchParams({ apiKey: this.cfg.publishableKey, ...extra });
    const query = '?' + usp.toString();
    const signature = this.signQuery(query);
    return `${base}${query}&signature=${encodeURIComponent(signature)}`;
  }
}
