import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class GroupingService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Puts one entry under another.
   *
   * Grouping **preserves**: the child keeps its row, its votes and its own page. Only what the
   * head displays changes — which is what separates this from the theme merge, where the loser
   * ceased to exist.
   */
  async group(creatorId: string, id: string, intoId: string): Promise<void> {
    if (id === intoId) {
      throw new BadRequestException('An entry cannot be grouped into itself');
    }

    // Scoped by creator: an id alone says nothing about which board owns it.
    const [entry, target] = await Promise.all([
      this.find(creatorId, id),
      this.find(creatorId, intoId),
    ]);

    // One level, in both directions. Arbitrary depth would make the de-duplicated sum a
    // recursive walk, and leave "which card do I open" unanswerable.
    if (entry.groupMemberCount > 0) {
      throw new ConflictException('That entry already carries a group; ungroup it first');
    }
    if (target.groupHeadId !== null) {
      throw new ConflictException('That entry is already inside a group');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.recommendation.update({ where: { id: entry.id }, data: { groupHeadId: target.id } });
      await this.recompute(tx, target.id);
    });
  }

  async ungroup(creatorId: string, id: string): Promise<void> {
    const entry = await this.find(creatorId, id);
    if (entry.groupHeadId === null) return;

    await this.prisma.$transaction(async (tx) => {
      await tx.recommendation.update({ where: { id: entry.id }, data: { groupHeadId: null } });
      // Both ends: the head loses what the child contributed, and the child goes back to
      // standing on its own votes.
      await this.recompute(tx, entry.groupHeadId as string);
      await this.recompute(tx, entry.id);
    });
  }

  /**
   * Rewrites an entry's stored totals from the votes across its whole group.
   *
   * **De-duplicated by voter, at their highest tier.** Someone who upvoted two entries that are
   * then grouped counts once — counting them twice inflates the head silently, and nothing about
   * the resulting number says it is wrong.
   *
   * Stored rather than computed on read because the board ranks on this column and pages by
   * keyset: a displayed weight computed separately from the ordering would put a group somewhere
   * its own number does not explain.
   */
  async recompute(tx: Prisma.TransactionClient, id: string): Promise<void> {
    await tx.$executeRaw`
      UPDATE "Recommendation" r
         SET "weightedScore" = COALESCE(totals.weight, 0),
             "upvoteCount"   = COALESCE(totals.people, 0)
        FROM (
              SELECT SUM(best.weight)::int AS weight,
                     COUNT(*)::int         AS people
                FROM (
                      -- One row per person, carrying the best tier they used anywhere in the
                      -- group. A vote with no tier is worth one, as everywhere else.
                      SELECT u."userId", MAX(COALESCE(t."voteWeight", 1)) AS weight
                        FROM "Upvote" u
                        JOIN "Recommendation" m
                          ON m."id" = u."recommendationId"
                   LEFT JOIN "Tier" t ON t."id" = u."tierId"
                       WHERE m."id" = ${id}::uuid OR m."groupHeadId" = ${id}::uuid
                    GROUP BY u."userId"
                     ) AS best
             ) AS totals
       WHERE r."id" = ${id}::uuid
    `;
  }

  private async find(creatorId: string, id: string) {
    const entry = await this.prisma.recommendation.findFirst({
      where: { id, creatorId },
      select: { id: true, groupHeadId: true, _count: { select: { groupMembers: true } } },
    });
    if (!entry) throw new NotFoundException();
    return {
      id: entry.id,
      groupHeadId: entry.groupHeadId,
      groupMemberCount: entry._count.groupMembers,
    };
  }
}
