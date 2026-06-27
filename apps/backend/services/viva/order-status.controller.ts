/**
 * PROJECT TITAN — Order status controller (DRIVING/interfaces).
 *
 *  GET /api/v1/checkout/orders/:orderCode -> the order's lifecycle status so the
 *  POS can poll after the customer pays on Viva's hosted page. Device-authed and
 *  terminal-scoped: a terminal can only read its own orders.
 */
import {
  Controller, ForbiddenException, Get, Headers, Inject, NotFoundException, Param, UseGuards,
} from '@nestjs/common';
import { DeviceAuthGuard } from './security/device-auth.guard';
import { GET_ORDER_STATUS } from './tokens';
import { GetOrderStatusService } from './get-order-status.service';

@Controller('api/v1')
@UseGuards(DeviceAuthGuard)
export class OrderStatusController {
  constructor(@Inject(GET_ORDER_STATUS) private readonly svc: GetOrderStatusService) {}

  @Get('checkout/orders/:orderCode')
  async status(
    @Headers('x-terminal-id') terminalId: string | undefined,
    @Param('orderCode') orderCode: string,
  ) {
    if (!terminalId) throw new ForbiddenException('missing authenticated terminal identity');
    const view = await this.svc.byOrderCodeForTerminal(orderCode, terminalId);
    if (!view) throw new NotFoundException('order not found');
    return view;
  }
}
