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
  databaseUrl: string;
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
    databaseUrl: env.DATABASE_URL ?? '',
  };
}
