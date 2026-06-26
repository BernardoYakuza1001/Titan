/**
 * PROJECT TITAN — Transaction API (Phase 4, Deliverable 6)
 *
 * Device-facing endpoint behind the API gateway (mTLS + attested device
 * session). Enforces profile constraints (caps, allowed capture methods/assets)
 * BEFORE starting the saga, then kicks off async orchestration. Idempotent: a
 * replayed idempotency key returns the existing transaction (409 semantics).
 */
import {
  Body, Controller, Get, Param, Post, Headers, HttpCode, ConflictException, BadRequestException,
} from '@nestjs/common';
import { IsArray, IsIn, IsNumber, IsPositive, IsString, Length } from 'class-validator';
import { TransactionSaga, TransactionContext } from './transaction.saga';
import { ProfileResolver } from '../profile/profile-resolver.service';
import { CardCapture, WalletCapture } from '@titan/profile-schema';

class ApprovalDto {
  @IsIn(['NONE', 'PIN_CVM', 'OPERATOR_CODE', 'OOB_OTP', 'OPERATOR_CODE+OOB_OTP']) type!: string;
  @IsString() code?: string;
}
class CaptureDto {
  @IsString() cardMethod!: CardCapture;
  @IsString() walletMethod!: WalletCapture;
  @IsString() panToken?: string;       // network token — never raw PAN
  approval!: ApprovalDto;
}
export class CreateTransactionDto {
  @IsString() profileId!: string;
  @IsNumber() @IsPositive() fiatAmount!: number;
  @IsString() @Length(3, 3) fiatCurrency!: string;
  @IsString() asset!: string;
  @IsString() chain!: string;
  @IsString() destWallet!: string;
  capture!: CaptureDto;
  @IsString() idempotencyKey!: string;
}

interface TxLookup {
  byIdempotencyKey(key: string): Promise<TransactionContext | null>;
  create(ctx: TransactionContext): Promise<void>;
  byId(id: string): Promise<TransactionContext | null>;
}

@Controller('v1/transactions')
export class TransactionController {
  constructor(
    private readonly saga: TransactionSaga,
    private readonly profiles: ProfileResolver,
    private readonly lookup: TxLookup,
    private readonly newId: () => string,
  ) {}

  @Post()
  @HttpCode(201)
  async create(
    @Headers('x-device-id') deviceId: string,
    @Headers('x-customer-id') customerId: string | undefined,
    @Headers('x-geo-country') geoCountry: string | undefined,
    @Body() dto: CreateTransactionDto,
  ) {
    // 1) Idempotency: replays return the existing transaction, no double-spend.
    const existing = await this.lookup.byIdempotencyKey(dto.idempotencyKey);
    if (existing) throw new ConflictException({ transactionId: existing.id, state: existing.state });

    // 2) Resolve the device's signed profile and enforce its constraints.
    const profile = await this.profiles.resolve(deviceId);
    const d = profile.dimensions;

    if (!d.assetSet.includes(dto.asset)) {
      throw new BadRequestException(`asset ${dto.asset} not permitted by profile ${profile.label}`);
    }
    if (!d.captureMethods.card.includes(dto.capture.cardMethod)) {
      throw new BadRequestException(`card capture ${dto.capture.cardMethod} not permitted`);
    }
    if (!d.captureMethods.wallet.includes(dto.capture.walletMethod)) {
      throw new BadRequestException(`wallet capture ${dto.capture.walletMethod} not permitted`);
    }
    if (dto.fiatAmount > d.txCaps.perTxn) {
      throw new BadRequestException(`amount exceeds per-txn cap (${d.txCaps.perTxn} ${d.txCaps.currency})`);
    }
    if (dto.capture.approval.type !== d.approvalPolicy.type) {
      throw new BadRequestException(`approval ${dto.capture.approval.type} != profile policy ${d.approvalPolicy.type}`);
    }

    // 3) Start the transaction and run the saga asynchronously.
    const ctx: TransactionContext = {
      id: this.newId(),
      deviceId,
      profile,
      fiatAmount: dto.fiatAmount,
      fiatCurrency: dto.fiatCurrency,
      asset: dto.asset,
      chain: dto.chain,
      destWallet: dto.destWallet,
      state: 'CREATED',
      customerId,
      cardToken: dto.capture.panToken,
      geoCountry,
    };
    await this.lookup.create(ctx);
    void this.saga.run(ctx); // fire-and-forget; client polls GET for state

    return { transactionId: ctx.id, state: 'AUTHORIZING' };
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    const ctx = await this.lookup.byId(id);
    if (!ctx) throw new BadRequestException('not found');
    return {
      id: ctx.id, state: ctx.state, fiatAmount: ctx.fiatAmount,
      asset: ctx.asset, chain: ctx.chain, destWallet: ctx.destWallet,
    };
  }
}
