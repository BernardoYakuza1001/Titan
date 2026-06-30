/**
 * PROJECT TITAN — Recurring (MIT) charge controller (DRIVING/interfaces).
 *
 *  POST /api/v1/recurring/charge -> charge a consenting cardholder again with NO
 *  3DS/OTP, by chaining off the initial authenticated transaction id. Device-authed
 *  and terminal-scoped (terminal id comes from the verified device identity).
 *
 *  Use only for genuine repeat charges to a cardholder who authenticated and
 *  consented at the initial payment (AllowRecurring order) — this is what makes it
 *  a compliant MIT rather than SCA evasion.
 */
import {
  Body, Controller, ForbiddenException, Headers, Inject, Post, UseGuards,
} from '@nestjs/common';
import { IsInt, IsOptional, IsPositive, IsString, Length } from 'class-validator';
import { RecurringChargeRecord } from './recurring.store';
import { RecurringChargeInput } from './process-recurring-charge.service';
import { ProcessRecurringChargeService } from './process-recurring-charge.service';
import { PROCESS_RECURRING_CHARGE } from './tokens';
import { DeviceAuthGuard } from './security/device-auth.guard';

export class CreateRecurringChargeDto {
  @IsString() @Length(8, 128) correlationToken!: string;
  @IsString() merchantId!: string;
  @IsString() @Length(1, 64) initialTransactionId!: string;
  @IsInt() @IsPositive() amountMinor!: number;
  @IsString() @Length(3, 3) currency!: string;
  @IsOptional() @IsString() customerTrns?: string;
}

@Controller('api/v1')
@UseGuards(DeviceAuthGuard)
export class RecurringController {
  constructor(
    @Inject(PROCESS_RECURRING_CHARGE) private readonly processCharge: ProcessRecurringChargeService,
  ) {}

  @Post('recurring/charge')
  async charge(
    @Headers('x-terminal-id') terminalId: string | undefined,
    @Body() dto: CreateRecurringChargeDto,
  ): Promise<RecurringChargeRecord> {
    if (!terminalId) throw new ForbiddenException('missing authenticated terminal identity');
    const input: RecurringChargeInput = {
      correlationToken: dto.correlationToken,
      terminalId,                                  // authoritative, from device identity
      merchantId: dto.merchantId,
      initialTransactionId: dto.initialTransactionId,
      amountMinor: dto.amountMinor,
      currency: dto.currency.toUpperCase(),
      customerTrns: dto.customerTrns,
    };
    return this.processCharge.process(input);
  }
}
