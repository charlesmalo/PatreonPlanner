import { Controller, Get, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

// An unresponsive dependency must not hold the probe open; orchestrators time the request out
// and retry, so a slow check is indistinguishable from a failed one but costs a connection.
const CHECK_TIMEOUT_MS = 2_000;

@Controller()
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

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
      this.check('db', () => this.prisma.ping()),
      this.check('redis', () => this.redis.ping()),
    ]);
    if (!db || !redis) {
      throw new HttpException(
        { status: 'unready', checks: { db, redis } },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return { status: 'ready', checks: { db, redis } };
  }

  private async check(name: string, probe: () => Promise<boolean>): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        probe(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`timed out after ${CHECK_TIMEOUT_MS}ms`)),
            CHECK_TIMEOUT_MS,
          );
        }),
      ]);
    } catch (error) {
      // Collapsing to `false` without this leaves a 503 with no explanation anywhere.
      this.logger.warn(`Readiness check "${name}" failed: ${(error as Error).message}`);
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
