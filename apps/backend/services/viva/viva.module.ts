/**
 * PROJECT TITAN — VivaAcquiringModule (NestJS composition root).
 *
 * Wires the hexagon: env config -> fetch HTTP + caching OAuth -> Viva adapter ->
 * use-cases -> Postgres ledger -> REST controller. Ports are bound by symbol
 * tokens (see tokens.ts); the controller @Inject()s the use-case tokens.
 *
 * The webhook/idempotency-sensitive nature of payments means the bootstrap should
 * use `NestFactory.create(AppModule, { rawBody: true })` if you later add Viva
 * webhooks; the charge flow here is request/response and needs no raw body.
 */
import { Module } from '@nestjs/common';
import { Pool } from 'pg';
import { SecurityModule } from './security/security.module';
import {
  VIVA_CONFIG, VIVA_HTTP, VIVA_TOKEN_PROVIDER, ACQUIRING_GATEWAY, VIVA_DB,
  LEDGER_REPOSITORY, PROCESS_MOTO_PAYMENT, QUERY_TERMINAL_HISTORY,
  TOKENIZATION_GATEWAY, TOKENIZE_USECASE, CHECKOUT_ORDER_GATEWAY, CREATE_CHECKOUT_ORDER,
} from './tokens';
import { vivaConfigFromEnv, VivaEnvConfig } from './viva.config';
import { FetchHttpClient } from './viva-http';
import { FetchTokenHttp, VivaOAuthTokenProvider } from './viva-token-provider';
import { VivaWalletAcquiringAdapter, HttpClient, VivaTokenProvider } from './viva.adapter';
import { BasicAuthProvider, BearerAuthProvider } from './viva-auth';
import { PgLedgerRepository, Queryable } from './pg-ledger.repository';
import { ProcessMotoPaymentService } from './process-moto-payment.service';
import { TerminalHistoryService } from './terminal-history.service';
import { VivaTokenizationGateway } from './viva-tokenization.gateway';
import { TokenizeService } from './tokenize.service';
import { TokenizationGateway } from './tokenization';
import { VivaOrderGateway } from './viva-order.gateway';
import { CreateCheckoutOrderService } from './create-checkout-order.service';
import { CheckoutOrderGateway } from './checkout';
import { AcquiringGateway, LedgerRepository } from './ports';
import { PaymentController } from './payment.controller';
import { TokenizeController } from './tokenize.controller';
import { CheckoutController } from './checkout.controller';
import { HealthController } from './health.controller';

@Module({
  imports: [SecurityModule],   // brings DeviceAuthGuard into scope for the controllers
  controllers: [PaymentController, TokenizeController, CheckoutController, HealthController],
  providers: [
    { provide: VIVA_CONFIG, useFactory: () => vivaConfigFromEnv() },

    { provide: VIVA_HTTP, useFactory: () => new FetchHttpClient() },

    {
      provide: VIVA_TOKEN_PROVIDER,
      useFactory: (cfg: VivaEnvConfig) => new VivaOAuthTokenProvider(new FetchTokenHttp(), cfg.oauth),
      inject: [VIVA_CONFIG],
    },

    {
      provide: ACQUIRING_GATEWAY,
      useFactory: (http: HttpClient, tokens: VivaTokenProvider, cfg: VivaEnvConfig) => {
        const useBasic = cfg.authScheme === 'basic';
        const auth = useBasic
          ? new BasicAuthProvider(cfg.basic.merchantId, cfg.basic.apiKey)   // Native Checkout
          : new BearerAuthProvider(tokens);                                 // OAuth /checkout/v2
        return new VivaWalletAcquiringAdapter(http, auth, {
          baseUrl: cfg.gateway.baseUrl,
          transactionsPath: useBasic ? cfg.nativeCheckoutPath : cfg.gateway.transactionsPath,
          sourceCode: cfg.gateway.sourceCode,
          sendCurrencyCode: !useBasic,   // Native Checkout derives currency from the source
        });
      },
      inject: [VIVA_HTTP, VIVA_TOKEN_PROVIDER, VIVA_CONFIG],
    },

    // pg Pool (lazy-connects on first query) wrapped as a Queryable.
    {
      provide: VIVA_DB,
      useFactory: (cfg: VivaEnvConfig): Queryable => {
        const pool = new Pool(cfg.databaseUrl ? { connectionString: cfg.databaseUrl } : {});
        return { query: (sql, params) => pool.query(sql, params as any[]) };
      },
      inject: [VIVA_CONFIG],
    },

    {
      provide: LEDGER_REPOSITORY,
      useFactory: (db: Queryable) => new PgLedgerRepository(db),
      inject: [VIVA_DB],
    },

    {
      provide: PROCESS_MOTO_PAYMENT,
      useFactory: (gw: AcquiringGateway, ledger: LedgerRepository) => new ProcessMotoPaymentService(gw, ledger),
      inject: [ACQUIRING_GATEWAY, LEDGER_REPOSITORY],
    },

    {
      provide: QUERY_TERMINAL_HISTORY,
      useFactory: (ledger: LedgerRepository) => new TerminalHistoryService(ledger),
      inject: [LEDGER_REPOSITORY],
    },

    {
      provide: TOKENIZATION_GATEWAY,
      useFactory: (http: HttpClient, tokens: VivaTokenProvider, cfg: VivaEnvConfig) => {
        const auth = cfg.authScheme === 'basic'
          ? new BasicAuthProvider(cfg.basic.merchantId, cfg.basic.apiKey)
          : new BearerAuthProvider(tokens);
        return new VivaTokenizationGateway(http, auth, { baseUrl: cfg.gateway.baseUrl, tokenizePath: cfg.tokenizePath });
      },
      inject: [VIVA_HTTP, VIVA_TOKEN_PROVIDER, VIVA_CONFIG],
    },

    {
      provide: TOKENIZE_USECASE,
      useFactory: (gw: TokenizationGateway) => new TokenizeService(gw),
      inject: [TOKENIZATION_GATEWAY],
    },

    {
      provide: CHECKOUT_ORDER_GATEWAY,
      useFactory: (http: HttpClient, tokens: VivaTokenProvider, cfg: VivaEnvConfig) => {
        // Order creation uses the same auth scheme as charge (Basic by default).
        const auth = cfg.authScheme === 'basic'
          ? new BasicAuthProvider(cfg.basic.merchantId, cfg.basic.apiKey)
          : new BearerAuthProvider(tokens);
        return new VivaOrderGateway(http, auth, {
          ordersUrl: cfg.ordersUrl,
          checkoutUrl: cfg.checkoutUrl,
          sourceCode: cfg.gateway.sourceCode,
        });
      },
      inject: [VIVA_HTTP, VIVA_TOKEN_PROVIDER, VIVA_CONFIG],
    },

    {
      provide: CREATE_CHECKOUT_ORDER,
      useFactory: (gw: CheckoutOrderGateway) => new CreateCheckoutOrderService(gw),
      inject: [CHECKOUT_ORDER_GATEWAY],
    },
  ],
})
export class VivaAcquiringModule {}
