import { Inject, Injectable, Logger } from '@nestjs/common';
import { CATALOG_PROVIDER, CatalogProvider } from '../catalog/catalog.provider';
import { RelationsService } from '../intelligence/relations.service';
import { PrismaService } from '../prisma/prisma.service';

/** Bounded so one tick cannot spend the whole third-party quota. Each title costs 3 TMDB calls. */
export const ENRICH_BATCH_SIZE = 10;

@Injectable()
export class EnrichTitleJob {
  private readonly logger = new Logger(EnrichTitleJob.name);

  constructor(
    private readonly relations: RelationsService,
    @Inject(CATALOG_PROVIDER) private readonly catalog: CatalogProvider,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Design §5: relations and themes are built in the background, not in the submit path — that
   * path is already the slowest and most abusable one, and three more network calls belong
   * nowhere near it. Returns how many titles were successfully enriched.
   */
  async runOnce(): Promise<number> {
    if (!this.catalog.isConfigured()) return 0;

    // Explicit `take`: the LIMIT Plan 04's membership job was missing.
    const pending = await this.prisma.title.findMany({
      where: { enrichedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
      take: ENRICH_BATCH_SIZE,
    });

    let enriched = 0;
    for (const title of pending) {
      try {
        await this.relations.enrich(title.id);
        enriched += 1;
      } catch (error) {
        // One bad title must not end the tick for the rest of the batch.
        this.logger.warn(`Enrichment failed for title ${title.id}: ${(error as Error).message}`);
      }
      // Stamped whatever happened, so a permanently failing title rotates to the back rather
      // than occupying the batch on every tick forever.
      await this.prisma.title.update({
        where: { id: title.id },
        data: { enrichedAt: new Date() },
      });
    }
    return enriched;
  }
}
