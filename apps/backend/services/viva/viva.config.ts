/**
 * PROJECT TITAN — Viva acquiring configuration from environment.
 * Client credentials come from the environment / secrets manager — never code.
 */
import { VivaConfig } from './viva.adapter';
import { VivaOAuthConfig } from './viva-token-provider';

export interface VivaEnvConfig {
  gateway: VivaConfig;
  oauth: VivaOAuthConfig;
  basic: { merchantId: string; apiKey: string };
  authScheme: 'basic' | 'oauth';
  nativeCheckoutPath: string;
  tokenizePath: string;
  ordersUrl: string;
  checkoutUrl: string;
  /** Optional MOTO payment source code. When set and a request asks for MOTO, the
   *  order is created against this source (MOTO is out of scope for 3DS/OTP). Empty
   *  = no MOTO source configured yet, so MOTO requests fall back to the e-com source. */
  motoSourceCode: string;
  databaseUrl: string;
  /** www base for the read-side confirmation API (transactions + webhook token). */
  wwwBaseUrl: string;
  /** optional shared secret required as ?whk= on the webhook POST (gate; '' = off). */
  webhookSecret: string;
  /** optional override for the Viva webhook verification token (else fetched live). */
  webhookToken: string;
}

export function vivaConfigFromEnv(env: NodeJS.ProcessEnv = process.env): VivaEnvConfig {
  return {
    gateway: {
      baseUrl: env.VIVA_BASE_URL ?? 'https://demo-api.viva.com',
      transactionsPath: env.VIVA_TRANSACTIONS_PATH ?? '/checkout/v2/transactions',
      sourceCode: env.VIVA_SOURCE_CODE ?? 'Default',
    },
    oauth: {
      accountsUrl: env.VIVA_ACCOUNTS_URL ?? 'https://demo-accounts.viva.com/connect/token',
      clientId: env.VIVA_CLIENT_ID ?? '',
      clientSecret: env.VIVA_CLIENT_SECRET ?? '',
    },
    basic: { merchantId: env.VIVA_MERCHANT_ID ?? '', apiKey: env.VIVA_API_KEY ?? '' },
    // Default to Basic auth (Native Checkout) — verified working on accounts where
    // the OAuth app lacks charge scopes. Set VIVA_AUTH_SCHEME=oauth to use Bearer.
    authScheme: env.VIVA_AUTH_SCHEME === 'oauth' ? 'oauth' : 'basic',
    nativeCheckoutPath: env.VIVA_NATIVE_CHECKOUT_PATH ?? '/nativecheckout/v2/transactions',
    tokenizePath: env.VIVA_TOKENIZE_PATH ?? '/acquiring/v1/cards/tokens',
    ordersUrl: env.VIVA_ORDERS_URL ?? 'https://www.vivapayments.com/api/orders',
    checkoutUrl: env.VIVA_CHECKOUT_URL ?? 'https://www.vivapayments.com/web/checkout',
    motoSourceCode: env.VIVA_MOTO_SOURCE_CODE ?? '',
    databaseUrl: env.DATABASE_URL ?? '',
    wwwBaseUrl: env.VIVA_WWW_BASE_URL ?? 'https://www.vivapayments.com',
    webhookSecret: env.VIVA_WEBHOOK_SECRET ?? '',
    webhookToken: env.VIVA_WEBHOOK_TOKEN ?? '',
  };
}
