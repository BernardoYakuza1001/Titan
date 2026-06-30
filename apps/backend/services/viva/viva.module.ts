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
  ORDER_REPOSITORY, VIVA_TX_VERIFIER, CONFIRM_CHECKOUT_PAYMENT, GET_ORDER_STATUS,
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
import { PgOrderRepository } from './pg-order.repository';
import { OrderRepository } from './checkout-order.store';
import { VivaTransactionVerifier, HttpGetClient } from './viva-verify';
import { ConfirmCheckoutPaymentService } from './confirm-checkout-payment.service';
import { GetOrderStatusService } from './get-order-status.service';
import { AcquiringGateway, LedgerRepository } from './ports';
import { PaymentController } from './payment.controller';
import { TokenizeController } from './tokenize.controller';
import { CheckoutController } from './checkout.controller';
import { OrderStatusController } from './order-status.controller';
import { VivaWebhookController } from './webhook.controller';
import { HealthController } from './health.controller';

@Module({
  imports: [SecurityModule],   // brings DeviceAuthGuard into scope for the controllers
  controllers: [
    PaymentController, TokenizeController, CheckoutController,
    OrderStatusController, VivaWebhookController, HealthController,
  ],
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
          motoSourceCode: cfg.motoSourceCode,
        });
      },
      inject: [VIVA_HTTP, VIVA_TOKEN_PROVIDER, VIVA_CONFIG],
    },

    // Persistence of the hosted-checkout order lifecycle (checkout_order, 011).
    {
      provide: ORDER_REPOSITORY,
      useFactory: (db: Queryable) => new PgOrderRepository(db),
      inject: [VIVA_DB],
    },

    {
      provide: CREATE_CHECKOUT_ORDER,
      useFactory: (gw: CheckoutOrderGateway, orders: OrderRepository, cfg: VivaEnvConfig) =>
        new CreateCheckoutOrderService(gw, orders, cfg.checkoutUrl),
      inject: [CHECKOUT_ORDER_GATEWAY, ORDER_REPOSITORY, VIVA_CONFIG],
    },

    // Read-side verifier: re-fetches the transaction from Viva to confirm webhooks.
    {
      provide: VIVA_TX_VERIFIER,
      useFactory: (http: HttpGetClient, tokens: VivaTokenProvider, cfg: VivaEnvConfig) => {
        const auth = cfg.authScheme === 'basic'
          ? new BasicAuthProvider(cfg.basic.merchantId, cfg.basic.apiKey)
          : new BearerAuthProvider(tokens);
        return new VivaTransactionVerifier(http, auth, {
          wwwBaseUrl: cfg.wwwBaseUrl,
          staticWebhookToken: cfg.webhookToken || undefined,
        });
      },
      inject: [VIVA_HTTP, VIVA_TOKEN_PROVIDER, VIVA_CONFIG],
    },

    {
      provide: CONFIRM_CHECKOUT_PAYMENT,
      useFactory: (orders: OrderRepository, verifier: VivaTransactionVerifier) =>
        new ConfirmCheckoutPaymentService(orders, verifier),
      inject: [ORDER_REPOSITORY, VIVA_TX_VERIFIER],
    },

    {
      provide: GET_ORDER_STATUS,
      useFactory: (orders: OrderRepository, verifier: VivaTransactionVerifier) =>
        new GetOrderStatusService(orders, verifier),
      inject: [ORDER_REPOSITORY, VIVA_TX_VERIFIER],
    },
  ],
})
export class VivaAcquiringModule {}
