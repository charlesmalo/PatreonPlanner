import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ConfigService } from '../config/config.module';
import { PrismaService } from '../prisma/prisma.service';
import { AVAILABILITY_PROVIDER, AvailabilityProvider } from './availability.provider';
import { AvailabilityOffer, AvailabilitySnapshot } from './availability.types';

const REGION_PATTERN = /^[A-Z]{2}$/;

/**
 * Ceiling on background refreshes started by reads. A cold board of twenty entries used to fire
 * twenty simultaneous upstream calls, and ten readers of that board fired two hundred. The
 * refresh job is the durable path — anything over this ceiling is simply left to it.
 */
export const MAX_IN_FLIGHT_REFRESHES = 8;

export interface StoredAvailability {
  region: string;
  link: string | null;
  offers: AvailabilityOffer[];
  fetchedAt: Date;
}

@Injectable()
export class AvailabilityService implements OnApplicationShutdown {
  private readonly logger = new Logger(AvailabilityService.name);
  /**
   * In-flight refreshes keyed by `titleId:region`. A map rather than a set of promises, because
   * the point is de-duplication: concurrent readers of the same cold board must share one
   * upstream call, not start one each.
   */
  private readonly inFlight = new Map<string, Promise<boolean>>();
  /** Set on shutdown so a draining process cannot be kept alive by newly queued work. */
  private stopping = false;

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
    // And it must be one we serve. The region is a free parameter on a VIEW-gated route, so an
    // open set lets one caller create a row — and a permanent refresh-job obligation — for every
    // country on earth.
    if (!this.regions().has(region)) {
      throw new BadRequestException('Availability is not offered for that region');
    }
  }

  private regions(): Set<string> {
    return new Set(this.config.get('AVAILABILITY_REGIONS').split(','));
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

    // A cold single read fetches synchronously — a client that asked specifically for
    // availability wants an answer — but still shares an in-flight call with any concurrent
    // reader of the same title.
    await this.dedupedRefresh(titleId, region);
    const row = await this.prisma.streamingAvailability.findUnique({
      where: { titleId_region: { titleId, region } },
    });
    return row ? toStored(row) : null;
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
    return this.dedupedRefresh(titleId, region);
  }

  /** One upstream call per (title, region) at a time, shared by every concurrent caller. */
  private dedupedRefresh(titleId: string, region: string): Promise<boolean> {
    const key = `${titleId}:${region}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const task = this.fetchAndStore(titleId, region)
      .then((stored) => stored !== null)
      .catch(() => false)
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, task);
    return task;
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
    // An unknown title is still an answer, and it is stored as one. Writing nothing would mean
    // "never asked", and every board read would queue another doomed fetch for the same title
    // forever — the failure this plan's own decision section forbids.
    const data = {
      link: snapshot?.link ?? null,
      offers: (snapshot?.offers ?? []) as unknown as Prisma.InputJsonValue,
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
    if (this.stopping) return;
    // Already being fetched, or the ceiling is reached — either way the refresh job will get to
    // it. Background top-up is best-effort by design.
    const key = `${titleId}:${region}`;
    if (this.inFlight.has(key) || this.inFlight.size >= MAX_IN_FLIGHT_REFRESHES) return;
    void this.dedupedRefresh(titleId, region);
  }

  /**
   * Awaits the refreshes reads kicked off. Bounded: `stopping` blocks new work during shutdown,
   * and an unbounded `while (size > 0)` would otherwise never terminate under sustained traffic.
   */
  async drainRefreshes(): Promise<void> {
    for (let pass = 0; pass < 10 && this.inFlight.size > 0; pass += 1) {
      await Promise.all([...this.inFlight.values()]);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    // Without this the Prisma client disconnects underneath in-flight upserts on SIGTERM.
    this.stopping = true;
    await this.drainRefreshes();
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
