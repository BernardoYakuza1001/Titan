/**
 * PROJECT TITAN — health probe. Unauthenticated (NO device guard) so the POS can
 * test backend reachability instantly before attempting an authed call.
 */
import { Controller, Get } from '@nestjs/common';

@Controller('api/v1')
export class HealthController {
  @Get('health')
  health() {
    return { ok: true, service: 'titan-acquiring' };
  }
}
