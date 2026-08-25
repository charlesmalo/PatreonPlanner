import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AbuseService } from '../abuse/abuse.service';
import { ConfigService } from '../config/config.module';
import { RateLimitService } from '../limits/rate-limit.service';
import { PrismaService } from '../prisma/prisma.service';
import { GroupingService } from './grouping.service';
import { HIDDEN_STATUSES } from './board-query';

/**
 * Casting and withdrawing an upvote, and keeping a group's total honest afterwards.
 *
 * Its own service because an upvote is not a read of the board and not a submission to it: it is
 * the one operation a patron performs repeatedly, it is rate limited and abuse scored on its own
 * terms, and its weight is recomputed from the tier they actually pledge rather than counted.
 *
 * `syncGroupHead` lives here rather than with grouping because it is the thing every vote must
 * remember to do — a group's score is the sum of its children, so a vote on a child that does
 * not roll up leaves the head displaying a number that was true a moment ago.
 */
@Injectable()
export class UpvotesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly limits: RateLimitService,
    private readonly abuse: AbuseService,
    private readonly config: ConfigService,
    private readonly grouping: GroupingService,
  ) {}

  /**
   * A vote lands on the entry it was cast on. When that entry sits inside a group, the head's
   * totals are derived from the whole group — so it is recomputed in the same transaction, or
   * the group's number quietly stops matching its members.
   */
  private async syncGroupHead(tx: Prisma.TransactionClient, recommendationId: string) {
    const entry = await tx.recommendation.findUnique({
      where: { id: recommendationId },
      select: { groupHeadId: true },
    });
    if (entry?.groupHeadId) await this.grouping.recompute(tx, entry.groupHeadId);
  }

  /**
   * The creator's own shortlist. Scoped by creator as well as id — an id alone says nothing about
   * which board an entry is on.
   */

  async toggleUpvote(creatorId: string, recommendationId: string, userId: string) {
    // Scoped by creatorId as well as id: the guard only proved access to *this* creator, so
    // without it a patron of A could upvote an entry on B's board by guessing an id.
    const rec = await this.prisma.recommendation.findFirst({
      where: { id: recommendationId, creatorId, status: { notIn: HIDDEN_STATUSES } },
      select: { id: true },
    });
    if (!rec) throw new NotFoundException();

    // The tier the voter holds *now*. Stored on the vote as a reference, so a creator rebalancing
    // later changes what this vote is worth — which is the point of recording the tier rather
    // than the number.
    const membership = await this.prisma.membership.findUnique({
      where: { userId_creatorId: { userId, creatorId } },
      select: { currentTierId: true, currentTier: { select: { voteWeight: true } } },
    });
    const tierId = membership?.currentTierId ?? null;
    // No tier is worth one: a board that lets someone vote is letting them vote, and free is
    // decided by the UPVOTE capability rather than by making the vote count for nothing.
    const weight = membership?.currentTier?.voteWeight ?? 1;

    // The row and both counters move together, so the numbers on the board cannot drift from the
    // rows behind them.
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.upvote.findUnique({
        where: { recommendationId_userId: { recommendationId, userId } },
        select: { id: true, tierId: true },
      });
      if (existing) {
        // Priced at what the vote was cast at, not at what the voter is worth today — otherwise
        // withdrawing after an upgrade would take away more than it ever added.
        const cast = existing.tierId
          ? ((
              await tx.tier.findUnique({
                where: { id: existing.tierId },
                select: { voteWeight: true },
              })
            )?.voteWeight ?? 1)
          : 1;
        await tx.upvote.delete({ where: { id: existing.id } });
        const updated = await tx.recommendation.update({
          where: { id: recommendationId },
          data: { upvoteCount: { decrement: 1 }, weightedScore: { decrement: cast } },
          select: { upvoteCount: true, weightedScore: true },
        });
        await this.syncGroupHead(tx, recommendationId);
        return {
          upvoted: false,
          upvoteCount: updated.upvoteCount,
          weightedScore: updated.weightedScore,
        };
      }
      await tx.upvote.create({ data: { recommendationId, userId, tierId } });
      const updated = await tx.recommendation.update({
        where: { id: recommendationId },
        data: { upvoteCount: { increment: 1 }, weightedScore: { increment: weight } },
        select: { upvoteCount: true, weightedScore: true },
      });
      await this.syncGroupHead(tx, recommendationId);
      return {
        upvoted: true,
        upvoteCount: updated.upvoteCount,
        weightedScore: updated.weightedScore,
      };
    });
  }

  /**
   * Explicit keyset pagination on (upvoteCount, createdAt, id).
   *
   * Prisma's `cursor` + `skip: 1` was wrong twice over: the skip is an unconditional OFFSET 1,
   * so when the cursor row is excluded by the status filter it eats a real row instead — pages
   * silently lost entries. And it resolves the cursor row by global id, so another creator's id
   * positioned the page. Carrying the boundary values in the cursor removes both.
   *
   * Duplicates remain possible if an entry is upvoted between pages, because the leading sort
   * key is mutable. That is inherent to ordering by a live counter, not something keyset fixes;
   * callers should de-duplicate by id.
   */
}
