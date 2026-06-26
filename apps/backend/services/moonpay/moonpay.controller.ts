/**
 * PROJECT TITAN — MoonPay HTTP surface (backend)
 *
 *  POST /v1/moonpay/sign-url   -> returns a signed MoonPay buy-widget URL.
 *      The Android app calls this instead of signing locally, so the SECRET key
 *      never leaves the server. The app then opens the returned URL/params.
 *
 *  POST /v1/moonpay/webhook    -> MoonPay calls this when a transaction changes
 *      state (e.g. completed). Signature is verified with the WEBHOOK key over
 *      the RAW request body before the event is trusted, then handed to a
 *      handler that finalizes the ledger.
 *
 * Wiring note: the webhook needs the EXACT raw bytes to verify the HMAC, so the
 * app must be bootstrapped with `NestFactory.create(AppModule, { rawBody: true })`
 * and a raw body parser for this route (req.rawBody).
 */
import {
  Body, Controller, Headers, HttpCode, Post, Req, UnauthorizedException,
} from '@nestjs/common';
import { MoonPayService } from './moonpay.service';
import { MoonPayConfig } from './moonpay.config';
import { verifyMoonPayWebhook } from './moonpay.webhook';

export interface SignBuyUrlDto {
  asset: string;                   // BTC | ETH | USDT …
  walletAddress: string;           // connected destination wallet
  fiatCurrency?: string;           // e.g. "eur"
  fiatAmount?: string;             // e.g. "200"
  externalTransactionId?: string;  // our Titan transaction id (reconciliation)
  externalCustomerId?: string;     // our KYC'd customer id
}

export interface MoonPayEvent {
  type: string;
  data: Record<string, unknown>;
}

/** Consumes verified MoonPay events (e.g. records delivery to the ledger). */
export interface MoonPayEventHandler {
  onEvent(event: MoonPayEvent): Promise<void>;
}

@Controller('v1/moonpay')
export class MoonPayController {
  constructor(
    private readonly svc: MoonPayService,
    private readonly cfg: MoonPayConfig,
    private readonly handler: MoonPayEventHandler,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  @Post('sign-url')
  signBuyUrl(@Body() dto: SignBuyUrlDto): { url: string } {
    const extra: Record<string, string> = {
      currencyCode: this.toMoonPayCurrency(dto.asset),
      walletAddress: dto.walletAddress,
    };
    if (dto.fiatCurrency) extra.baseCurrencyCode = dto.fiatCurrency.toLowerCase();
    if (dto.fiatAmount) extra.baseCurrencyAmount = dto.fiatAmount;
    if (dto.externalTransactionId) extra.externalTransactionId = dto.externalTransactionId;
    if (dto.externalCustomerId) extra.externalCustomerId = dto.externalCustomerId;
    return { url: this.svc.buildSignedBuyUrl(extra) };
  }

  @Post('webhook')
  @HttpCode(200)
  async webhook(
    @Req() req: { rawBody?: Buffer | string },
    @Headers('moonpay-signature-v2') signature: string,
  ): Promise<{ received: boolean }> {
    const raw = typeof req.rawBody === 'string'
      ? req.rawBody
      : (req.rawBody?.toString('utf8') ?? '');

    const ok = verifyMoonPayWebhook(raw, signature ?? '', this.cfg.webhookKey, {
      toleranceSeconds: 300,
      nowSeconds: this.now(),
    });
    if (!ok) throw new UnauthorizedException('invalid MoonPay signature');

    const event = JSON.parse(raw) as MoonPayEvent;
    await this.handler.onEvent(event);
    return { received: true };
  }

  private toMoonPayCurrency(asset: string): string {
    switch (asset.toUpperCase()) {
      case 'BTC': return 'btc';
      case 'ETH': return 'eth';
      case 'USDT': return 'usdt';
      default: return asset.toLowerCase();
    }
  }
}
