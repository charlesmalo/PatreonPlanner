import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { StaffRoleValue } from '../access/capability';
import { ConfigService } from '../config/config.module';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeTitle } from './normalize-title';
import {
  BOARD_ONLY_DEFAULTS,
  RECOMMENDATION_FIELDS,
  present,
  visibilityWhere,
} from './recommendations.service';

/** Bounded so a broad query cannot ask Postgres to rank and return the whole board. */
export const MAX_SEARCH_RESULTS = 8;

/**
 * Candidates are fetched well past the result cap because the *visibility* filter runs after
 * them. A popular title with a pile of rejected near-duplicates — exactly what moderating spam
 * produces, and DELETED rows accumulate forever — would otherwise fill every candidate slot and
 * return an empty result, blinding search for that title permanently.
 */
const CANDIDATE_MULTIPLIER = 6;

/** Below this, trigram ranking is noise and the index is no help. */
const MIN_QUERY_LENGTH = 2;

/** Bounds the worst case on an endpoint reachable anonymously on a public board. */
const STATEMENT_TIMEOUT_MS = 3000;

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
    // Normalised for *both* comparisons. Binding the raw string to the alias side let a NUL byte
    // through to Postgres, which answered 22021 and surfaced as an anonymous, repeatable 500.
    const normalized = normalizeTitle(query);
    // A query of pure punctuation normalises to nothing, and a trigram match on "" ranks
    // everything — so it is too short rather than merely unproductive.
    if (normalized.length < MIN_QUERY_LENGTH) {
      throw new BadRequestException('Search for at least two characters');
    }

    const orderedIds = await this.rankCandidates(creator.id, normalized);
    if (orderedIds.length === 0) return { items: [] };

    const rows = await this.prisma.recommendation.findMany({
      where: {
        // AND, never spread: `visibilityWhere` can return an `OR`, and spreading it beside
        // another key is how the board's own visibility filter once got silently overwritten.
        AND: [{ id: { in: orderedIds }, creatorId: creator.id }, visibilityWhere(creator, viewer)],
      },
      select: {
        ...RECOMMENDATION_FIELDS,
        ...(viewer.userId
          ? { upvotes: { where: { userId: viewer.userId }, select: { id: true }, take: 1 } }
          : {}),
      },
    });

    // `IN` returns rows in whatever order Postgres likes; the ranking has to be reapplied. The
    // slice happens *after* the visibility filter, which is the point of over-fetching.
    const byId = new Map(rows.map((row) => [(row as { id: string }).id, row]));
    return {
      items: orderedIds
        .flatMap((id) => {
          const row = byId.get(id) as ({ upvotes?: Array<{ id: string }> } & object) | undefined;
          if (!row) return [];
          const { upvotes, ...rest } = row;
          return [
            {
              ...present(rest),
              hasUpvoted: (upvotes ?? []).length > 0,
              // Same shape as a board entry: a client renders these with the same card.
              ...BOARD_ONLY_DEFAULTS,
            },
          ];
        })
        .slice(0, MAX_SEARCH_RESULTS),
    };
  }

  /**
   * Ids by descending match quality.
   *
   * Two indexable arms unioned rather than one `OR` across a join: an `OR` spanning
   * `Recommendation` and the joined `TitleAlias` forces join-then-filter, and `similarity()` in a
   * WHERE clause is not indexable at all — that combination measured 914ms of sequential scan on
   * 200k rows where the indexed form is 0.15ms.
   *
   * `<%` is the operator pg_trgm provides for "is the query a fragment of the target", which is
   * what a type-ahead actually asks. Plain `similarity()` scored "spirited" against "Spirited
   * Away in the Land of the Gods" at 0.26 — below any usable threshold — because it penalises
   * the length of the target.
   */
  private async rankCandidates(creatorId: string, normalized: string): Promise<string[]> {
    const threshold = String(this.config.get('SEARCH_SIMILARITY_THRESHOLD'));
    const limit = MAX_SEARCH_RESULTS * CANDIDATE_MULTIPLIER;

    const [, , ranked] = await this.prisma.$transaction([
      // `<%` reads its cut-off from a GUC rather than an argument; `true` scopes both settings to
      // this transaction.
      this.prisma
        .$executeRaw`SELECT set_config('pg_trgm.word_similarity_threshold', ${threshold}, true)`,
      this.prisma.$executeRaw`SELECT set_config('statement_timeout', ${String(
        STATEMENT_TIMEOUT_MS,
      )}, true)`,
      this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        WITH candidates AS (
          SELECT r."id", word_similarity(${normalized}, r."normalizedTitle") AS score
          FROM "Recommendation" r
          WHERE r."creatorId" = ${creatorId}::uuid
            AND ${normalized} <% r."normalizedTitle"
          UNION ALL
          SELECT r."id", word_similarity(${normalized}, a."text") AS score
          FROM "Recommendation" r
          JOIN "TitleAlias" a ON a."titleId" = r."titleId"
          WHERE r."creatorId" = ${creatorId}::uuid
            AND ${normalized} <% a."text"
        )
        SELECT "id", MAX(score) AS score
        FROM candidates
        GROUP BY "id"
        ORDER BY score DESC, "id"
        LIMIT ${limit}
      `),
    ]);

    return ranked.map((row) => row.id);
  }
}
