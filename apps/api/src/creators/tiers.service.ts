import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class TiersService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Changes what a tier is worth, and repairs every score it touches in the same transaction.
   *
   * A vote stores its tier rather than a copied number precisely so a rebalance reaches votes
   * already cast — but the board ranks on a stored column, because a keyset cursor has to compare
   * something the database can order. So the column is recomputed here rather than left to
   * disagree with the tiers until someone votes again.
   *
   * Recomputed from the votes grouped by tier, not by walking every vote: one creator's rows, on
   * an explicit admin action.
   */
  async setWeight(
    creatorId: string,
    tierId: string,
    changes: { voteWeight?: number; tokensPerPeriod?: number },
  ): Promise<{ id: string; voteWeight: number; tokensPerPeriod: number }> {
    // Scoped by creator: a tier id alone says nothing about which board owns it.
    const tier = await this.prisma.tier.findFirst({
      where: { id: tierId, creatorId },
      select: { id: true },
    });
    if (!tier) throw new NotFoundException();

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.tier.update({
        where: { id: tier.id },
        data: {
          ...(changes.voteWeight !== undefined ? { voteWeight: changes.voteWeight } : {}),
          ...(changes.tokensPerPeriod !== undefined
            ? { tokensPerPeriod: changes.tokensPerPeriod }
            : {}),
        },
        select: { id: true, voteWeight: true, tokensPerPeriod: true },
      });

      // Only a weight change can move a score. Rescoring the whole board because somebody
      // changed how many tokens a tier grants would be a table scan for nothing — and tokens
      // deliberately have no bearing on the weighted score at all.
      if (changes.voteWeight === undefined) return updated;

      // A vote with no tier is worth one, which is why COALESCE carries a default rather than the
      // join dropping those rows.
      await tx.$executeRaw`
        UPDATE "Recommendation" r
           SET "weightedScore" = COALESCE(scores.total, 0)
          FROM (
                SELECT u."recommendationId" AS id,
                       SUM(COALESCE(t."voteWeight", 1))::int AS total
                  FROM "Upvote" u
                  JOIN "Recommendation" rec ON rec."id" = u."recommendationId"
             LEFT JOIN "Tier" t ON t."id" = u."tierId"
                 WHERE rec."creatorId" = ${creatorId}::uuid
              GROUP BY u."recommendationId"
               ) AS scores
         WHERE r."id" = scores.id
      `;
      // An entry whose every vote was withdrawn has no row in the aggregate above, so it would
      // keep whatever score it had. Scoped to this creator, as everything here is.
      await tx.$executeRaw`
        UPDATE "Recommendation" r
           SET "weightedScore" = 0
         WHERE r."creatorId" = ${creatorId}::uuid
           AND NOT EXISTS (SELECT 1 FROM "Upvote" u WHERE u."recommendationId" = r."id")
           AND r."weightedScore" <> 0
      `;
      return updated;
    });
  }
}
