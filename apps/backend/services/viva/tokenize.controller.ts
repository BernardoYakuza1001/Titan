/**
 * PROJECT TITAN — Tokenize controller (DRIVING/interfaces).
 *
 *  POST /api/v1/tokenize  -> exchanges a PAX P2PE-encrypted card payload for a
 *  single-use Viva chargeToken (PaymentToken-shaped response). Device-authed.
 *
 * The request carries CIPHERTEXT, not card data — meaningless without the DUKPT
 * key held in the backend HSM — so this endpoint stays within the no-raw-PAN/CVV
 * boundary. The POS then submits the returned token to POST /api/v1/payments.
 */
import {
  Body, Controller, ForbiddenException, Headers, HttpException, HttpStatus, Inject, Post, UseGuards,
} from '@nestjs/common';
import { IsIn, IsInt, IsString, Length, Matches, Max, Min } from 'class-validator';
import { TokenizeUseCase } from './tokenization';
import { CardBrand, AcquiringErrorCode } from './domain';
import { TOKENIZE_USECASE } from './tokens';
import { DeviceAuthGuard } from './security/device-auth.guard';

const CARD_BRANDS = ['VISA', 'MASTERCARD', 'AMEX', 'DISCOVER', 'DINERS', 'JCB', 'UNIONPAY', 'UNKNOWN'];

export class TokenizeDto {
  @IsString() @Length(8, 128) correlationToken!: string;
  @IsString() @Length(1, 8192) encryptedPayload!: string;   // base64 P2PE ciphertext
  @IsString() @Length(1, 64) ksn!: string;
  @Matches(/^[0-9]{0,6}\*{2,}[0-9]{4}$/) maskedPan!: string; // masked only — rejects a full PAN
  @IsIn(CARD_BRANDS) cardBrand!: CardBrand;
  @IsInt() @Min(1) @Max(12) expiryMonth!: number;
  @IsInt() @Min(2000) @Max(2100) expiryYear!: number;
}

/** Card declines -> 402; gateway/config faults -> 502. */
function httpStatusFor(code: AcquiringErrorCode | undefined): number {
  switch (code) {
    case 'GATEWAY_TIMEOUT':
    case 'GATEWAY_ERROR':
    case 'CONFIGURATION_ERROR':
    case 'UNKNOWN':
    case undefined:
      return HttpStatus.BAD_GATEWAY;       // 502
    default:
      return HttpStatus.PAYMENT_REQUIRED;  // 402
  }
}

@Controller('api/v1')
@UseGuards(DeviceAuthGuard)
export class TokenizeController {
  constructor(@Inject(TOKENIZE_USECASE) private readonly tokenize: TokenizeUseCase) {}

  @Post('tokenize')
  async createToken(
    @Headers('x-terminal-id') terminalId: string | undefined,
    @Body() dto: TokenizeDto,
  ) {
    if (!terminalId) throw new ForbiddenException('missing authenticated terminal identity');

    const outcome = await this.tokenize.tokenize(
      {
        encryptedPayload: dto.encryptedPayload,
        ksn: dto.ksn,
        maskedPan: dto.maskedPan,
        cardBrand: dto.cardBrand,
        expiryMonth: dto.expiryMonth,
        expiryYear: dto.expiryYear,
      },
      dto.correlationToken,
    );

    if (!outcome.ok || !outcome.chargeToken) {
      throw new HttpException(
        { error: outcome.error?.code ?? 'TOKENIZATION_FAILED', message: outcome.error?.message ?? 'tokenization failed' },
        httpStatusFor(outcome.error?.code),
      );
    }

    // PaymentToken-shaped response the POS feeds into POST /api/v1/payments.
    return {
      token: outcome.chargeToken,
      maskedPan: dto.maskedPan,
      cardBrand: dto.cardBrand,
      expiryMonth: dto.expiryMonth,
      expiryYear: dto.expiryYear,
      tokenProvider: 'viva',
      expiresAtEpochMs: outcome.expiresAtMs,
    };
  }
}
