import { Controller, Get, HttpException, HttpStatus } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

@Controller()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Get('healthz')
  liveness(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('readyz')
  async readiness(): Promise<{ status: 'ready'; checks: { db: boolean; redis: boolean } }> {
    const [db, redis] = await Promise.all([
      this.prisma.ping().catch(() => false),
      this.redis.ping().catch(() => false),
    ]);
    if (!db || !redis) {
      throw new HttpException(
        { status: 'unready', checks: { db, redis } },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return { status: 'ready', checks: { db, redis } };
  }
}
