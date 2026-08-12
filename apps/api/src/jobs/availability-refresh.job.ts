import { Injectable, Logger } from '@nestjs/common';
import { AvailabilityService } from '../availability/availability.service';
import { ConfigService } from '../config/config.module';
import { PrismaService } from '../prisma/prisma.service';

/** Bounded so one tick cannot spend the whole third-party quota. */
export const AVAILABILITY_BATCH_SIZE = 25;

@Injectable()
export class AvailabilityRefreshJob {
  private readonly logger = new Logger(AvailabilityRefreshJob.name);

  constructor(
    private readonly availability: AvailabilityService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Design §5's TTL background refresh. Returns how many rows were successfully refreshed.
   *
   * Every row is stamped on *attempt*, success or failure. Plan 04's membership job shipped
   * without that and a permanently failing subject occupied the batch on every tick forever.
   */
  async runOnce(): Promise<number> {
    // Nothing to ask and nothing to store. Without this the job spends a tick calling a provider
    // that will refuse every request.
    if (!this.availability.isConfigured()) return 0;

    const ttlHours = this.config.get('AVAILABILITY_TTL_HOURS');
    const cutoff = new Date(Date.now() - ttlHours * 60 * 60 * 1000);

    // An explicit `take` — this is the LIMIT the membership job was missing.
    const stale = await this.prisma.streamingAvailability.findMany({
      where: { fetchedAt: { lt: cutoff } },
      orderBy: { fetchedAt: 'asc' },
      select: { id: true, titleId: true, region: true },
      take: AVAILABILITY_BATCH_SIZE,
    });
    if (stale.length === 0) return 0;

    let refreshed = 0;
    for (const row of stale) {
      try {
        // The service swallows upstream errors so a background refresh cannot crash a request,
        // so its boolean — not the absence of a throw — is what says the lookup worked.
        if (await this.availability.refresh(row.titleId, row.region)) refreshed += 1;
      } catch (error) {
        // One bad title must not end the tick for the rest of the batch.
        this.logger.warn(
          `Availability refresh failed for title ${row.titleId} in ${row.region}: ${
            (error as Error).message
          }`,
        );
      }
      // Stamped whatever happened. `refresh` only writes fetchedAt on a successful upsert, so
      // without this a failing row keeps its old timestamp and is picked first again next tick.
      await this.prisma.streamingAvailability.updateMany({
        where: { id: row.id, fetchedAt: { lt: cutoff } },
        data: { fetchedAt: new Date() },
      });
    }
    return refreshed;
  }
}
