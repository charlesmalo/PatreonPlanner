import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ConfigService } from '../config/config.module';
import { PrismaService } from '../prisma/prisma.service';
import { AVAILABILITY_PROVIDER, AvailabilityProvider } from './availability.provider';
import { AvailabilityOffer, AvailabilitySnapshot } from './availability.types';

const REGION_PATTERN = /^[A-Z]{2}$/;

export interface StoredAvailability {
  region: string;
  link: string | null;
  offers: AvailabilityOffer[];
  fetchedAt: Date;
}

@Injectable()
export class AvailabilityService {
  private readonly logger = new Logger(AvailabilityService.name);
  /**
   * In-flight background refreshes. Tracked so tests can await them and so shutdown does not
   * abandon a write mid-flight — not a queue: the durable work belongs to the refresh job, and
   * this is only the opportunistic top-up a read triggers.
   */
  private readonly refreshes = new Set<Promise<void>>();

  constructor(
    @Inject(AVAILABILITY_PROVIDER) private readonly provider: AvailabilityProvider,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private ttlMs(): number {
    return this.config.get('AVAILABILITY_TTL_HOURS') * 60 * 60 * 1000;
  }

  private assertRegion(region: string): void {
    // Rejected here rather than at the column: VARCHAR(2) would take 'gb' happily, and a
    // lowercase region silently misses every row the job writes with an uppercase one.
    if (!REGION_PATTERN.test(region)) {
      throw new BadRequestException('Region must be a two-letter ISO-3166-1 country code');
    }
  }

  private isStale(fetchedAt: Date): boolean {
    return Date.now() - fetchedAt.getTime() > this.ttlMs();
  }

  /**
   * The single-title path. Fetches synchronously on a complete miss — a client that asked
   * specifically for availability wants an answer, not an empty body and a promise.
   */
  async forTitle(titleId: string, region: string): Promise<StoredAvailability | null> {
    this.assertRegion(region);
    if (!this.provider.isConfigured()) return null;

    const existing = await this.prisma.streamingAvailability.findUnique({
      where: { titleId_region: { titleId, region } },
    });

    if (existing) {
      // Stale-while-revalidate: answer now from what we have, ask upstream behind it.
      if (this.isStale(existing.fetchedAt)) this.queueRefresh(titleId, region);
      return toStored(existing);
    }

    const snapshot = await this.fetchAndStore(titleId, region);
    return snapshot;
  }

  /**
   * The board's path. Returns only what is already stored and tops up in the background: a board
   * of twenty entries must not wait on twenty third-party calls, and a card without a badge is a
   * far smaller problem than a page that will not load.
   */
  async forTitles(titleIds: string[], region: string): Promise<Map<string, StoredAvailability>> {
    this.assertRegion(region);
    const result = new Map<string, StoredAvailability>();
    if (titleIds.length === 0 || !this.provider.isConfigured()) return result;

    const rows = await this.prisma.streamingAvailability.findMany({
      where: { titleId: { in: titleIds }, region },
    });

    const seen = new Set<string>();
    for (const row of rows) {
      seen.add(row.titleId);
      result.set(row.titleId, toStored(row));
      if (this.isStale(row.fetchedAt)) this.queueRefresh(row.titleId, region);
    }
    // Never asked about these. The next render has them.
    for (const titleId of titleIds) {
      if (!seen.has(titleId)) this.queueRefresh(titleId, region);
    }

    return result;
  }

  /** True when a provider is configured at all. The refresh job skips its whole tick without one. */
  isConfigured(): boolean {
    return this.provider.isConfigured();
  }

  /**
   * Asks upstream and writes the answer. Used by the refresh job and by a cold single read.
   * Returns whether an answer was actually stored — errors are swallowed here so a background
   * refresh cannot crash a request, which means the boolean is the only way a caller learns the
   * lookup failed. Without it the job counted every attempt as a success.
   */
  async refresh(titleId: string, region: string): Promise<boolean> {
    this.assertRegion(region);
    if (!this.provider.isConfigured()) return false;
    return (await this.fetchAndStore(titleId, region)) !== null;
  }

  private async fetchAndStore(titleId: string, region: string): Promise<StoredAvailability | null> {
    const title = await this.prisma.title.findUnique({
      where: { id: titleId },
      select: { tmdbId: true, mediaType: true },
    });
    if (!title) return null;

    let snapshot: AvailabilitySnapshot | null;
    try {
      snapshot = await this.provider.fetch(title.tmdbId, title.mediaType, region);
    } catch (error) {
      // Stored nothing on purpose: an outage cached as "available nowhere" would outlive it by
      // the whole TTL.
      this.logger.warn(
        `Availability lookup failed for title ${titleId} in ${region}: ${(error as Error).message}`,
      );
      return null;
    }
    // The upstream does not know this title at all — distinct from knowing it and having no
    // offers, which is an empty snapshot and does get stored.
    if (!snapshot) return null;

    const data = {
      link: snapshot.link,
      offers: snapshot.offers as unknown as Prisma.InputJsonValue,
      fetchedAt: new Date(),
    };
    const row = await this.prisma.streamingAvailability.upsert({
      where: { titleId_region: { titleId, region } },
      create: { titleId, region, ...data },
      update: data,
    });
    return toStored(row);
  }

  private queueRefresh(titleId: string, region: string): void {
    const task = this.refresh(titleId, region)
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        this.refreshes.delete(task);
      });
    this.refreshes.add(task);
  }

  /** Awaits the background refreshes a read kicked off. For tests and for graceful shutdown. */
  async drainRefreshes(): Promise<void> {
    while (this.refreshes.size > 0) {
      await Promise.all([...this.refreshes]);
    }
  }
}

function toStored(row: {
  region: string;
  link: string | null;
  offers: Prisma.JsonValue;
  fetchedAt: Date;
}): StoredAvailability {
  return {
    region: row.region,
    link: row.link,
    offers: (row.offers ?? []) as unknown as AvailabilityOffer[],
    fetchedAt: row.fetchedAt,
  };
}
