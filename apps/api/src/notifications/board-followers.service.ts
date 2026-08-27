import { Injectable } from '@nestjs/common';
import { Prisma, RecommendationStatus } from '@prisma/client';
import { can, type Policy, type Viewer } from '../access/capability';

/**
 * What a reader hears about by default: an entry starting, and an entry finishing.
 *
 * Not every move. `PENDING → ACCEPTED` is board administration — it says a moderator triaged
 * something, which is news to the submitter and to nobody else. Defaulting to the full set makes
 * the first login a firehose, and a firehose is switched off before it is ever configured.
 */
export const DEFAULT_MOVE_STATUSES: RecommendationStatus[] = ['ACTIVE', 'COMPLETED'];

/** Only what the audience query needs; keeps the shape honest at the call site. */
type FollowerRow = {
  userId: string;
  user: {
    memberships: Array<{ amountCents: number; isActivePatron: boolean }>;
    staffRoles: Array<{ role: 'OWNER' | 'MOD' }>;
    notificationPreferences: Array<{ statuses: RecommendationStatus[] }>;
  };
};

@Injectable()
export class BoardFollowersService {
  /**
   * Who hears that something moved on this board.
   *
   * Visibility is resolved here, per follower, rather than filtered when the bell is read. A
   * stored notification carries the entry's title, so a row that exists for someone who may not
   * read the board has already handed out what the policy was protecting — hiding it on display
   * is a decision made far too late.
   *
   * Favouriting is a bookmark, not an entitlement: a SUBSCRIBERS_ONLY board can be favourited by
   * somebody who has never pledged to it, and by somebody whose pledge has since lapsed.
   *
   * Takes the caller's transaction so the read cannot see a board state the write is about to
   * roll back.
   */
  async audienceFor(
    tx: Prisma.TransactionClient,
    creatorId: string,
    toStatus: RecommendationStatus,
    exclude: Array<string | null>,
  ): Promise<string[]> {
    const excluded = exclude.filter((id): id is string => id !== null);

    const [followers, policy] = await Promise.all([
      tx.creatorFavorite.findMany({
        where: { creatorId, userId: { notIn: excluded } },
        select: {
          userId: true,
          user: {
            select: {
              memberships: {
                where: { creatorId },
                select: { amountCents: true, isActivePatron: true },
              },
              staffRoles: { where: { creatorId }, select: { role: true } },
              notificationPreferences: { where: { creatorId }, select: { statuses: true } },
            },
          },
        },
      }),
      this.policyFor(tx, creatorId),
    ]);

    return (
      (followers as FollowerRow[])
        .filter((row) => wants(row, toStatus))
        // The same pure resolver the guard calls. Never a second implementation of "may they see
        // this board" — two of those drift, and the one over here fails silently.
        .filter((row) => can('VIEW', viewerFrom(row), policy))
        .map((row) => row.userId)
    );
  }

  private async policyFor(tx: Prisma.TransactionClient, creatorId: string): Promise<Policy> {
    const policy = await tx.creatorPolicy.findUniqueOrThrow({
      where: { creatorId },
      select: {
        viewVisibility: true,
        submitMinTier: { select: { amountCents: true } },
        upvoteMinTier: { select: { amountCents: true } },
      },
    });
    return {
      viewVisibility: policy.viewVisibility,
      submitMinTierAmountCents: policy.submitMinTier?.amountCents ?? null,
      upvoteMinTierAmountCents: policy.upvoteMinTier?.amountCents ?? null,
    };
  }
}

/** Absent row means the default; an empty array means silence. Never collapse the two. */
function wants(row: FollowerRow, toStatus: RecommendationStatus): boolean {
  const preference = row.user.notificationPreferences[0];
  const statuses = preference ? preference.statuses : DEFAULT_MOVE_STATUSES;
  return statuses.includes(toStatus);
}

function viewerFrom(row: FollowerRow): Viewer {
  const membership = row.user.memberships[0];
  return {
    userId: row.userId,
    isAuthenticated: true,
    isActivePatron: membership?.isActivePatron ?? false,
    // Null rather than 0 when they do not pledge: 0 would clear a gate set at 0.
    pledgeAmountCents: membership?.isActivePatron ? (membership.amountCents ?? null) : null,
    staffRole: row.user.staffRoles[0]?.role ?? null,
    permissions: [],
  };
}
