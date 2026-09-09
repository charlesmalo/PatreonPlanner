import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '../config/config.module';
import { EMBEDDING_PROVIDER, EmbeddingProvider } from '../embeddings/embedding.provider';
import { PrismaService } from '../prisma/prisma.service';
import { buildPassage, embeddingSignature } from '../embeddings/passage';

/** One inference call per tick. Transformer cost amortises heavily across a batch. */
export const EMBED_BATCH_SIZE = 32;

@Injectable()
export class EmbedTitlesJob {
  private readonly logger = new Logger(EmbedTitlesJob.name);

  constructor(
    @Inject(EMBEDDING_PROVIDER) private readonly embeddings: EmbeddingProvider,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Design §5's vectorisation, in the background because inference is tens to hundreds of
   * milliseconds on CPU and the submit path is already the slowest thing in the product.
   *
   * Returns how many titles were embedded.
   */
  async runOnce(): Promise<number> {
    if (!this.embeddings.isConfigured()) return 0;
    // The signature, not the bare model id: a row embedded from a different *recipe* is as
    // incomparable as one embedded by a different model, and bumping PASSAGE_VERSION is what
    // makes a recipe change re-embed rather than mix two spaces in one column.
    const model = embeddingSignature(this.embeddings.modelId());

    // Never embedded, or embedded by a model this deployment no longer uses. The second clause is
    // what makes rotation a re-embed rather than two incomparable vector spaces in one column.
    const pending = await this.prisma.title.findMany({
      where: { OR: [{ embeddingModel: null }, { embeddingModel: { not: model } }] },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        name: true,
        overview: true,
        aliases: { select: { text: true }, take: 8 },
      },
      take: EMBED_BATCH_SIZE,
    });
    if (pending.length === 0) return 0;

    // The recipe lives beside its version in `passage.ts`, so the two cannot drift apart.
    const texts = pending.map((title) => buildPassage(title));

    let vectors: number[][];
    try {
      vectors = await this.embeddings.embedPassages(texts);
    } catch (error) {
      // One bad batch must not stop the queue forever; the rows keep their null model and are
      // retried on the next tick.
      this.logger.warn(`Embedding batch failed: ${(error as Error).message}`);
      return 0;
    }

    let embedded = 0;
    for (const [index, title] of pending.entries()) {
      try {
        // Raw: Prisma has no vector type, and a width mismatch is a Postgres error here rather
        // than a silently wrong column.
        await this.prisma.$executeRaw`
          UPDATE "Title"
          SET "embedding" = ${`[${vectors[index].join(',')}]`}::vector,
              "embeddingModel" = ${model},
              "embeddedAt" = NOW()
          WHERE "id" = ${title.id}::uuid
        `;
        embedded += 1;
      } catch (error) {
        this.logger.warn(`Could not store embedding for ${title.id}: ${(error as Error).message}`);
      }
    }
    return embedded;
  }
}
