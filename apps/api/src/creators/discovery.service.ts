import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export const MAX_DISCOVERY_RESULTS = 20;
/** Below this a query matches most of the table, which is a listing rather than a search. */
export const MIN_QUERY_LENGTH = 2;

export interface DiscoveredCreator {
  id: string;
  slug: string;
  displayName: string;
  /** The reader put this on their own shortlist. */
  favorited: boolean;
  /** The reader has a membership here — including a lapsed one, which is still a relationship. */
  supported: boolean;
}

@Injectable()
export class DiscoveryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Ordered by how much the reader already has to do with each board: their own shortlist first,
   * then boards they support, then everyone else. A stranger's board is the least useful answer
   * to "which of these did I mean", so it sorts last rather than by name alone.
   *
   * Ordering happens in SQL rather than after the limit, or the page would be sorted but the
   * wrong entries would be on it.
   */
  async search(query: string, userId?: string): Promise<{ items: DiscoveredCreator[] }> {
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) return { items: [] };

    const pattern = `%${trimmed.toLowerCase()}%`;
    // No userId is the signed-out case: the joins still run, they simply match nothing, so one
    // query serves both rather than two that could drift apart.
    const reader = userId ?? '00000000-0000-0000-0000-000000000000';

    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        slug: string;
        displayName: string;
        favorited: boolean;
        supported: boolean;
      }>
    >`
      SELECT c."id",
             c."slug",
             c."displayName",
             f."userId" IS NOT NULL AS "favorited",
             m."userId" IS NOT NULL AS "supported"
      FROM "Creator" c
      LEFT JOIN "CreatorFavorite" f
        ON f."creatorId" = c."id" AND f."userId" = ${reader}::uuid
      LEFT JOIN "Membership" m
        ON m."creatorId" = c."id" AND m."userId" = ${reader}::uuid
      WHERE lower(c."displayName") LIKE ${pattern} OR lower(c."slug") LIKE ${pattern}
      ORDER BY (f."userId" IS NOT NULL) DESC,
               (m."userId" IS NOT NULL) DESC,
               c."displayName" ASC
      LIMIT ${MAX_DISCOVERY_RESULTS}
    `;
    return { items: rows };
  }

  /** Idempotent: a second click is the same intent, not an error. */
  async favorite(slug: string, userId: string): Promise<void> {
    const creator = await this.findBySlug(slug);
    await this.prisma.creatorFavorite.upsert({
      where: { userId_creatorId: { userId, creatorId: creator.id } },
      create: { userId, creatorId: creator.id },
      update: {},
    });
  }

  /** Scoped by userId as well as board: a slug says nothing about whose shortlist it is on. */
  async unfavorite(slug: string, userId: string): Promise<void> {
    const creator = await this.findBySlug(slug);
    await this.prisma.creatorFavorite.deleteMany({ where: { userId, creatorId: creator.id } });
  }

  private async findBySlug(slug: string) {
    const creator = await this.prisma.creator.findUnique({
      where: { slug },
      select: { id: true },
    });
    if (!creator) throw new NotFoundException();
    return creator;
  }
}
