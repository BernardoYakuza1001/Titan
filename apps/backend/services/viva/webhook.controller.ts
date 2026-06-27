/**
 * PROJECT TITAN — Viva webhook receiver (DRIVING/interfaces). NOT device-authed:
 * Viva calls these, not a terminal.
 *
 *  GET  /api/v1/viva/webhook  -> verification handshake. Must return { Key } or
 *                                Viva refuses to register the webhook. The Key is
 *                                a public handshake token (grants nothing), so the
 *                                GET is intentionally ungated.
 *  POST /api/v1/viva/webhook  -> a payment event. The body is UNTRUSTED; the
 *                                confirm service re-verifies every "paid" event
 *                                against Viva's transactions API. An optional
 *                                shared-secret query param (?whk=) is a cheap first
 *                                gate when VIVA_WEBHOOK_SECRET is configured.
 */
import { Body, Controller, Get, HttpCode, Inject, Post, Query } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { VIVA_TX_VERIFIER, CONFIRM_CHECKOUT_PAYMENT, VIVA_CONFIG } from './tokens';
import { VivaTransactionVerifier } from './viva-verify';
import { ConfirmCheckoutPaymentService, WebhookEvent } from './confirm-checkout-payment.service';
import { VivaEnvConfig } from './viva.config';

function str(v: unknown): string | null {
  return v === undefined || v === null ? null : String(v);
}

@Controller('api/v1/viva')
export class VivaWebhookController {
  constructor(
    @Inject(VIVA_TX_VERIFIER) private readonly verifier: VivaTransactionVerifier,
    @Inject(CONFIRM_CHECKOUT_PAYMENT) private readonly confirm: ConfirmCheckoutPaymentService,
    @Inject(VIVA_CONFIG) private readonly cfg: VivaEnvConfig,
  ) {}

  /** Optional first-line gate; disabled (always open) when no secret is configured.
   *  Constant-time compare so the secret can't be recovered by timing. */
  private gateOk(whk?: string): boolean {
    const secret = this.cfg.webhookSecret;
    if (!secret) return true;
    if (typeof whk !== 'string') return false;
    const a = Buffer.from(whk);
    const b = Buffer.from(secret);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  @Get('webhook')
  async verify(): Promise<{ Key: string }> {
    const Key = await this.verifier.getWebhookToken();
    return { Key };
  }

  @Post('webhook')
  @HttpCode(200)
  async event(@Query('whk') whk: string | undefined, @Body() body: any): Promise<{ ok: true; result: string }> {
    // Always ack 200 (so Viva does not retry-storm), but only ACT when the gate
    // passes and the confirm service independently verifies the transaction.
    if (!this.gateOk(whk)) {
      return { ok: true, result: 'IGNORED_GATE' };
    }
    const data = body?.EventData ?? body?.eventData ?? {};
    const ev: WebhookEvent = {
      eventTypeId: Number(body?.EventTypeId ?? body?.eventTypeId ?? 0),
      orderCode: str(data.OrderCode ?? data.orderCode),
      transactionId: str(data.TransactionId ?? data.transactionId),
    };
    const result = await this.confirm.handle(ev);
    return { ok: true, result };
  }
}
