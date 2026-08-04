import { Controller, Get } from '@nestjs/common';

@Controller()
export class HealthController {
  @Get('healthz')
  liveness(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
