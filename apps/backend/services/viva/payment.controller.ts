/**
 * PROJECT TITAN — Payment + Terminal History controllers (DRIVING/interfaces).
 *
 *  POST /api/v1/payments              -> process a MOTO sale (token charge)
 *  GET  /api/v1/terminal/history      -> terminal-scoped ledger history (reprint/audit)
 *
 * The stateless POS sends only the single-use token + masked metadata; raw card
 * data never reaches this layer. The history endpoint is terminal-scoped: the
 * caller may only read its OWN terminal's records — the terminal id is taken from
 * the authenticated device identity (x-terminal-id, set by the device-auth guard),
 * NOT from a query param the caller can spoof.
 */
import {
  BadRequestException, Body, Controller, ForbiddenException, Get, Headers, Inject, Post, Query, UseGuards,
} from '@nestjs/common';
import { IsIn, IsInt, IsPositive, IsString, Length, Matches } from 'class-validator';
import { ProcessMotoPaymentUseCase, QueryTerminalHistoryUseCase } from './ports';
import { CardBrand, PaymentIntent, TransactionRecord } from './domain';
import { PROCESS_MOTO_PAYMENT, QUERY_TERMINAL_HISTORY } from './tokens';
import { DeviceAuthGuard } from './security/device-auth.guard';

const CARD_BRANDS = ['VISA', 'MASTERCARD', 'AMEX', 'DISCOVER', 'DINERS', 'JCB', 'UNIONPAY', 'UNKNOWN'];

export class CreatePaymentDto {
  @IsString() @Length(8, 128) correlationToken!: string;
  @IsString() merchantId!: string;
  @IsInt() @IsPositive() amountMinor!: number;
  @IsString() @Length(3, 3) currency!: string;
  @IsString() paymentToken!: string;                 // single-use Viva chargeToken
  @Matches(/^[0-9]{0,6}\*{2,}[0-9]{4}$/) maskedPan!: string;  // masked only — rejects a full PAN
  @IsIn(CARD_BRANDS) cardBrand!: CardBrand;
}

@Controller('api/v1')
@UseGuards(DeviceAuthGuard)   // every route requires a verified device credential
export class PaymentController {
  constructor(
    @Inject(PROCESS_MOTO_PAYMENT) private readonly processPayment: ProcessMotoPaymentUseCase,
    @Inject(QUERY_TERMINAL_HISTORY) private readonly history: QueryTerminalHistoryUseCase,
  ) {}

  @Post('payments')
  async createPayment(
    @Headers('x-terminal-id') terminalId: string | undefined,
    @Body() dto: CreatePaymentDto,
  ): Promise<TransactionRecord> {
    if (!terminalId) throw new ForbiddenException('missing authenticated terminal identity');
    const intent: PaymentIntent = {
      correlationToken: dto.correlationToken,
      terminalId,                              // authoritative, from device identity
      merchantId: dto.merchantId,
      amountMinor: dto.amountMinor,
      currency: dto.currency.toUpperCase(),
      paymentToken: dto.paymentToken,
      maskedPan: dto.maskedPan,
      cardBrand: dto.cardBrand,
    };
    return this.processPayment.process(intent);
  }

  @Get('terminal/history')
  async terminalHistory(
    @Headers('x-terminal-id') terminalId: string | undefined,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<TransactionRecord[]> {
    if (!terminalId) throw new ForbiddenException('missing authenticated terminal identity');
    const lim = limit !== undefined ? Number(limit) : 50;
    const off = offset !== undefined ? Number(offset) : 0;
    if (Number.isNaN(lim) || Number.isNaN(off)) throw new BadRequestException('limit/offset must be numbers');
    // terminalId comes from the device identity, so a terminal can only read its own rows.
    return this.history.byTerminal(terminalId, lim, off);
  }
}
