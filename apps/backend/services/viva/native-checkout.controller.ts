/**
 * PROJECT TITAN — Native Checkout v2 (keyed MOTO) support endpoints.
 *
 *  GET /api/v1/viva/native-session  (device-authed) -> { accessToken, baseUrl,
 *      sourceCode } the front-end SDK needs to tokenize a keyed card. The access
 *      token is a short-lived OAuth client-credentials token; it is only handed to
 *      an authenticated terminal. NOTE: this account's OAuth scopes are currently
 *      posmanagement/ecr, so tokenization will fail until an online card-token
 *      scope is granted — the endpoint itself is correct and ready.
 *
 *  GET /api/v1/viva/card-capture    (ungated) -> the keyed-card capture page. It
 *      holds no secrets; the app passes the session via the URL fragment.
 */
import { Controller, Get, Header, Headers, Inject, UseGuards } from '@nestjs/common';
import { DeviceAuthGuard } from './security/device-auth.guard';
import { VIVA_TOKEN_PROVIDER, VIVA_CONFIG } from './tokens';
import { VivaTokenProvider } from './viva.adapter';
import { VivaEnvConfig } from './viva.config';
import { CARD_CAPTURE_HTML } from './card-capture.page';

@Controller('api/v1/viva')
export class NativeCheckoutController {
  constructor(
    @Inject(VIVA_TOKEN_PROVIDER) private readonly tokens: VivaTokenProvider,
    @Inject(VIVA_CONFIG) private readonly cfg: VivaEnvConfig,
  ) {}

  @Get('native-session')
  @UseGuards(DeviceAuthGuard)
  async session(@Headers('x-terminal-id') terminalId?: string): Promise<{ accessToken: string; baseUrl: string; sourceCode: string }> {
    const accessToken = await this.tokens.accessToken();
    return {
      accessToken,
      baseUrl: this.cfg.gateway.baseUrl,
      sourceCode: this.cfg.motoSourceCode || this.cfg.gateway.sourceCode,
    };
  }

  @Get('card-capture')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  capture(): string {
    return CARD_CAPTURE_HTML;
  }
}
