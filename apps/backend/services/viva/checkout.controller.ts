/**
 * PROJECT TITAN — Checkout controller (DRIVING/interfaces).
 *
 *  POST /api/v1/checkout/orders -> create a Viva hosted-checkout order; returns
 *  { orderCode, checkoutUrl }. The POS opens checkoutUrl in a WebView and the
 *  customer pays on Viva's hosted page — no card data ever reaches Titan.
 *
 * Device-authed; terminal id comes from the verified device identity.
 */
import {
  Body, Controller, ForbiddenException, Headers, HttpException, HttpStatus, Inject, Post, UseGuards,
} from '@nestjs/common';
import { IsBoolean, IsInt, IsOptional, IsPositive, IsString, Length } from 'class-validator';
import { CreateCheckoutOrderUseCase } from './checkout';
import { AcquiringErrorCode } from './domain';
import { CREATE_CHECKOUT_ORDER } from './tokens';
import { DeviceAuthGuard } from './security/device-auth.guard';

export class CreateOrderDto {
  @IsString() @Length(8, 128) correlationToken!: string;
  @IsString() merchantId!: string;
  @IsInt() @IsPositive() amountMinor!: number;
  @IsString() @Length(3, 3) currency!: string;
  @IsOptional() @IsString() customerTrns?: string;
  @IsOptional() @IsBoolean() moto?: boolean;
  @IsOptional() @IsBoolean() recurring?: boolean;
}

function httpStatusFor(code: AcquiringErrorCode | undefined): number {
  switch (code) {
    case 'GATEWAY_TIMEOUT':
    case 'GATEWAY_ERROR':
    case 'CONFIGURATION_ERROR':
    case 'UNKNOWN':
    case undefined:
      return HttpStatus.BAD_GATEWAY;       // 502
    default:
      return HttpStatus.UNPROCESSABLE_ENTITY; // 422 (bad order request)
  }
}

@Controller('api/v1')
@UseGuards(DeviceAuthGuard)
export class CheckoutController {
  constructor(@Inject(CREATE_CHECKOUT_ORDER) private readonly createOrder: CreateCheckoutOrderUseCase) {}

  @Post('checkout/orders')
  async create(
    @Headers('x-terminal-id') terminalId: string | undefined,
    @Body() dto: CreateOrderDto,
  ) {
    if (!terminalId) throw new ForbiddenException('missing authenticated terminal identity');

    const outcome = await this.createOrder.create({
      amountMinor: dto.amountMinor,
      currency: dto.currency.toUpperCase(),
      correlationToken: dto.correlationToken,
      terminalId,
      merchantId: dto.merchantId,
      customerTrns: dto.customerTrns,
      moto: dto.moto,
      recurring: dto.recurring,
    });

    if (!outcome.ok || !outcome.checkoutUrl) {
      throw new HttpException(
        { error: outcome.error?.code ?? 'ORDER_FAILED', message: outcome.error?.message ?? 'order creation failed' },
        httpStatusFor(outcome.error?.code),
      );
    }
    return { orderCode: outcome.orderCode, checkoutUrl: outcome.checkoutUrl };
  }
}
