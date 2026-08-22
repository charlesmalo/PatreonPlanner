import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface MyVote {
  recommendationId: string;
  title: string;
  status: string;
  /** What this vote is worth today — the weight of the tier it was cast at. */
  worth: number;
}

/**
 * A patron's own votes on one board, and the one action they can take on them.
 *
 * Per board rather than global: a vote is worth what *this* creator's tiers say it is, and a list
 * mixing boards would be a column of numbers that mean different things.
 */
@Injectable()
export class MyVotesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(creatorId: string, userId: string) {
    const [votes, membership] = await Promise.all([
      this.prisma.upvote.findMany({
        where: { userId, recommendation: { creatorId } },
        select: {
          tierId: true,
          tier: { select: { voteWeight: true } },
          recommendation: { select: { id: true, customTitle: true, status: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.membership.findUnique({
        where: { userId_creatorId: { userId, creatorId } },
        select: { currentTier: { select: { voteWeight: true } } },
      }),
    ]);

    // No tier is worth one, the same as when a vote is cast.
    const currentWorth = membership?.currentTier?.voteWeight ?? 1;
    const items: MyVote[] = votes.map((vote) => ({
      recommendationId: vote.recommendation.id,
      title: vote.recommendation.customTitle,
      status: vote.recommendation.status,
      worth: vote.tier?.voteWeight ?? 1,
    }));

    return {
      items,
      currentWorth,
      // Only upward: a vote already worth more than the reader's current tier is not something
      // this offers to change.
      couldImprove: items.filter((item) => item.worth < currentWorth).length,
    };
  }

  /**
   * Lifts votes cast at a cheaper tier to the reader's current one.
   *
   * Upward only, and never automatic. Someone who paid more, even for a month, keeps what that
   * bought; someone who downgrades keeps it too, rather than having it taken back. A creator who
   * would rather the board tracked current support turns the whole thing off.
   */
  async refresh(
    creator: { id: string; allowVoteRatchet: boolean },
    userId: string,
  ): Promise<{ updated: number }> {
    if (!creator.allowVoteRatchet) {
      throw new ForbiddenException('This board does not update votes to a new tier');
    }

    const membership = await this.prisma.membership.findUnique({
      where: { userId_creatorId: { userId, creatorId: creator.id } },
      select: { currentTierId: true, currentTier: { select: { voteWeight: true } } },
    });
    const currentTierId = membership?.currentTierId ?? null;
    const currentWorth = membership?.currentTier?.voteWeight ?? 1;

    const votes = await this.prisma.upvote.findMany({
      where: { userId, recommendation: { creatorId: creator.id } },
      select: { id: true, recommendationId: true, tier: { select: { voteWeight: true } } },
    });
    const liftable = votes
      .map((vote) => ({ ...vote, worth: vote.tier?.voteWeight ?? 1 }))
      .filter((vote) => vote.worth < currentWorth);
    if (liftable.length === 0) return { updated: 0 };

    // The votes and the scores move together: a lifted vote whose entry kept its old score would
    // leave the board ranking on a number nothing behind it agrees with.
    await this.prisma.$transaction(async (tx) => {
      for (const vote of liftable) {
        await tx.upvote.update({ where: { id: vote.id }, data: { tierId: currentTierId } });
        await tx.recommendation.update({
          where: { id: vote.recommendationId },
          // The difference only. The headcount is untouched — the same person is still one person.
          data: { weightedScore: { increment: currentWorth - vote.worth } },
        });
      }
    });
    return { updated: liftable.length };
  }
}
