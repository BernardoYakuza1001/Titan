/**
 * MoonPay configuration. Secret + webhook keys are read from the environment
 * (e.g. a secrets manager / Vault in production) — NEVER committed or shipped in
 * the APK. Only the publishable key is safe to expose client-side.
 */
export interface MoonPayConfig {
  publishableKey: string;   // pk_… — safe in the app
  secretKey: string;        // sk_… — SERVER ONLY (URL signing + REST API)
  webhookKey: string;       // wk_… — SERVER ONLY (webhook signature verification)
  environment: 'sandbox' | 'production';
}

export function moonPayConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MoonPayConfig {
  return {
    publishableKey: env.MOONPAY_PUBLISHABLE_KEY ?? '',
    secretKey: env.MOONPAY_SECRET_KEY ?? '',
    webhookKey: env.MOONPAY_WEBHOOK_KEY ?? '',
    environment: env.MOONPAY_ENV === 'production' ? 'production' : 'sandbox',
  };
}
