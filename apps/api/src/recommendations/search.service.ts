import { BadRequestException, Injectable } from '@nestjs/common';
import type { StaffRoleValue } from '../access/capability';
import { ConfigService } from '../config/config.module';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeTitle } from './normalize-title';
import { RECOMMENDATION_FIELDS, present, visibilityWhere } from './recommendations.service';

/** Bounded so a broad query cannot ask Postgres to rank and return the whole board. */
export const MAX_SEARCH_RESULTS = 8;

/** Below this, trigram ranking is noise and the index is no help. */
const MIN_QUERY_LENGTH = 2;

type Viewer = { userId: string | null; staffRole: StaffRoleValue | null };

@Injectable()
export class SearchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Design §5's "already submitted?": what is on this board that looks like what you are typing.
   *
   * Candidates come from SQL; *visibility* comes from the board's own read model. Writing the
   * status rules into the query would have been shorter and would have silently diverged the
   * first time those rules changed — which they have, twice.
   */
  async similar(
    creator: { id: string; hidePendingFromPublic: boolean },
    query: string,
    viewer: Viewer,
  ) {
    const normalized = normalizeTitle(query);
    // A query of pure punctuation normalises to nothing, and a trigram match on "" ranks
    // everything — so it is too short rather than merely unproductive.
    if (normalized.length < MIN_QUERY_LENGTH) {
      throw new BadRequestException('Search for at least two characters');
    }

    const threshold = this.config.get('SEARCH_SIMILARITY_THRESHOLD');
    const ranked = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT r."id",
             GREATEST(
               similarity(r."normalizedTitle", ${normalized}),
               COALESCE(MAX(similarity(a."text", ${query})), 0)
             ) AS score
      FROM "Recommendation" r
      LEFT JOIN "TitleAlias" a ON a."titleId" = r."titleId"
      WHERE r."creatorId" = ${creator.id}::uuid
        AND (
          similarity(r."normalizedTitle", ${normalized}) >= ${threshold}
          OR similarity(a."text", ${query}) >= ${threshold}
        )
      GROUP BY r."id", r."normalizedTitle"
      ORDER BY score DESC, r."id"
      LIMIT ${MAX_SEARCH_RESULTS}
    `;

    const orderedIds = ranked.map((row) => row.id);
    if (orderedIds.length === 0) return { items: [] };

    const rows = await this.prisma.recommendation.findMany({
      where: {
        id: { in: orderedIds },
        creatorId: creator.id,
        // The board's own rule, by the same function. A change there reaches search for free.
        ...visibilityWhere(creator, viewer),
      },
      select: {
        ...RECOMMENDATION_FIELDS,
        ...(viewer.userId
          ? { upvotes: { where: { userId: viewer.userId }, select: { id: true }, take: 1 } }
          : {}),
      },
    });

    // `IN` returns rows in whatever order Postgres likes; the ranking has to be reapplied.
    const byId = new Map(rows.map((row) => [(row as { id: string }).id, row]));
    return {
      items: orderedIds.flatMap((id) => {
        const row = byId.get(id) as ({ upvotes?: Array<{ id: string }> } & object) | undefined;
        if (!row) return [];
        const { upvotes, ...rest } = row;
        return [{ ...present(rest), hasUpvoted: (upvotes ?? []).length > 0 }];
      }),
    };
  }
}
