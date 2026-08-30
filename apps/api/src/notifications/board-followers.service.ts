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
    notificationPreferences: Array<{ statuses: RecommendationStatus[]; themeIds: string[] }>;
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
    // The themes of the entry that moved, already scoped to this board by the caller. Empty for
    // an entry with no catalogue title, which is the whole cost of reusing the creator's themes.
    entryThemeIds: string[] = [],
    // The entry that moved, so people who follow it specifically can be found. Absent means
    // nobody can, which is what every caller before this feature meant.
    recommendationId?: string,
  ): Promise<string[]> {
    const excluded = exclude.filter((id): id is string => id !== null);

    /** Both sources answer the same questions below, so they select the same shape. */
    const aboutTheReader = {
      userId: true,
      user: {
        select: {
          memberships: {
            where: { creatorId },
            select: { amountCents: true, isActivePatron: true },
          },
          staffRoles: { where: { creatorId }, select: { role: true } },
          notificationPreferences: {
            where: { creatorId },
            select: { statuses: true, themeIds: true },
          },
        },
      },
    } as const;

    const [followers, watchers, policy] = await Promise.all([
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
              notificationPreferences: {
                where: { creatorId },
                select: { statuses: true, themeIds: true },
              },
            },
          },
        },
      }),
      // People who follow this one entry, whether or not they follow the board. That is the case
      // the feature exists for: a board too noisy to follow, with one thing on it worth hearing
      // about.
      recommendationId
        ? tx.entryFollow.findMany({
            where: { recommendationId, userId: { notIn: excluded } },
            select: aboutTheReader,
          })
        : Promise.resolve([]),
      this.policyFor(tx, creatorId),
    ]);

    // Following the entry beats the theme narrowing; following the board does not. Statuses
    // answer *what counts as news* and are applied to both, because a reader who asked to hear
    // only about Now Playing asked that about everything — including the show they wait on.
    const watching = new Set((watchers as FollowerRow[]).map((row) => row.userId));
    // Two reasons to hear about it is still one thing that happened.
    const audience = new Map<string, FollowerRow>();
    for (const row of [...(followers as FollowerRow[]), ...(watchers as FollowerRow[])]) {
      audience.set(row.userId, row);
    }

    return (
      [...audience.values()]
        .filter(
          (row) =>
            wants(row, toStatus) &&
            (watching.has(row.userId) || aboutSomethingTheyAskedFor(row, entryThemeIds)),
        )
        // The same pure resolver the guard calls, applied to both sources. Never a second
        // implementation of "may they see this board" — two of those drift, and the one over here
        // fails silently. A follow is a wish, not an entitlement.
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

/**
 * Whether this entry is about something the reader narrowed to.
 *
 * An empty list means every theme, which is the opposite of the empty `statuses` beside it meaning
 * silence. Narrowing by theme is something you opt into; choosing no columns is choosing nothing.
 * Collapsing the two would have silenced everybody who set a column preference before themes
 * existed.
 *
 * A reader who has narrowed hears nothing about an entry carrying no themes at all — which is
 * every external link and every hand-typed name, because themes hang off a catalogue title. That
 * is the price of reusing the creator's vocabulary rather than keeping a private one, and it is
 * paid here.
 */
function aboutSomethingTheyAskedFor(row: FollowerRow, entryThemeIds: string[]): boolean {
  const wanted = row.user.notificationPreferences[0]?.themeIds ?? [];
  if (wanted.length === 0) return true;
  return entryThemeIds.some((id) => wanted.includes(id));
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
