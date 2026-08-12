import { Inject, Injectable } from '@nestjs/common';
import { MediaType, Prisma, RelationKind } from '@prisma/client';
import { CATALOG_PROVIDER, CatalogProvider } from '../catalog/catalog.provider';
import { PrismaService } from '../prisma/prisma.service';
import { ThemesService } from './themes.service';

@Injectable()
export class RelationsService {
  constructor(
    @Inject(CATALOG_PROVIDER) private readonly catalog: CatalogProvider,
    private readonly prisma: PrismaService,
    private readonly themes: ThemesService,
  ) {}

  /**
   * Design §5's relationship graph, built from TMDB's structured data. Idempotent: every write
   * goes through the `(fromId, toId, kind)` unique index, so a re-run cannot multiply rows.
   */
  async enrich(titleId: string): Promise<void> {
    const title = await this.prisma.title.findUnique({
      where: { id: titleId },
      select: { id: true, tmdbId: true, mediaType: true },
    });
    if (!title) return;

    const structure = await this.catalog.fetchStructure(title.tmdbId, title.mediaType);

    // A film's collection is worth creating as a Title even if nobody has suggested it: it is the
    // container everything else nests under, and TMDB hands it to us named.
    if (structure.collection) {
      const collection = await this.prisma.title.upsert({
        where: {
          tmdbId_mediaType: { tmdbId: structure.collection.tmdbId, mediaType: 'COLLECTION' },
        },
        create: {
          tmdbId: structure.collection.tmdbId,
          mediaType: 'COLLECTION',
          name: structure.collection.name,
        },
        update: {},
        select: { id: true },
      });
      await this.link(title.id, collection.id, 'SAME_FRANCHISE', null);
    }

    // A collection's members are only linked when they already exist. A part nobody has suggested
    // is not worth a catalogue row; it becomes one when someone suggests it.
    for (const part of structure.parts) {
      const member = await this.findTitle(part.tmdbId, part.mediaType);
      if (member) await this.link(member.id, title.id, 'SAME_FRANCHISE', part.ordinal);
    }

    for (const similar of structure.similar) {
      const other = await this.findTitle(similar.tmdbId, similar.mediaType);
      if (other) await this.link(title.id, other.id, 'RELATED', null);
    }

    // Themes are per creator, so they are seeded for every creator with this title on their board.
    const creators = await this.prisma.recommendation.findMany({
      where: { titleId: title.id },
      select: { creatorId: true },
      distinct: ['creatorId'],
    });
    for (const { creatorId } of creators) {
      await this.themes.seedFor(title.id, creatorId, structure.labels);
    }
  }

  private findTitle(tmdbId: number, mediaType: MediaType) {
    return this.prisma.title.findUnique({
      where: { tmdbId_mediaType: { tmdbId, mediaType } },
      select: { id: true },
    });
  }

  private async link(
    fromId: string,
    toId: string,
    kind: RelationKind,
    ordinal: number | null,
  ): Promise<void> {
    // TMDB's similar list can include the subject itself, and a self-relation would nest a board
    // entry under itself. The check constraint rejects it too; this avoids the round trip.
    if (fromId === toId) return;
    try {
      await this.prisma.titleRelation.upsert({
        where: { fromId_toId_kind: { fromId, toId, kind } },
        create: { fromId, toId, kind, ordinal },
        update: { ordinal },
      });
    } catch (error) {
      // A concurrent enrich of the same pair is not worth failing the whole title for.
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) {
        throw error;
      }
    }
  }
}
