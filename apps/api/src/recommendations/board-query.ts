import { BadRequestException } from '@nestjs/common';
import { Prisma, RecommendationStatus } from '@prisma/client';
import type { StaffRoleValue } from '../access/capability';
import { PATRON_VISIBLE_STATUSES } from '../moderation/transitions';

/**
 * How a board page is chosen, ordered, and continued.
 *
 * Ordering and its cursor live in one module because they are two halves of one decision: a
 * board whose `ORDER BY` and whose "everything after this row" clause disagree pages silently
 * wrong — it drops entries or repeats them, and every individual page still looks correct.
 * Keeping them in separate files is how they drift apart, so they are derived together here.
 */

export const MAX_PAGE = 50;

// Not writable. DELETED is a soft delete and REJECTED a moderation outcome; neither may be
// upvoted, whatever the read model shows a moderator.
export const HIDDEN_STATUSES: RecommendationStatus[] = ['DELETED', 'REJECTED'];

/**
 * How a column is ordered, and the keyset that pages it.
 *
 * Both are derived from one place on purpose: an ordering and a cursor comparison that disagree
 * page the wrong way silently — rows repeat or vanish, and nothing errors.
 */
export function boardOrdering(
  sort: BoardSort,
  /**
   * Whether this board's creator has redeem tokens switched on.
   *
   * Zero for every entry on a board that never enabled them, so the key would change no ordering
   * there — but a board that enabled them, collected redeems and switched them *off* still has
   * non-zero counts, and kept sorting by a feature its settings say is off. Defaults to off so a
   * caller that forgets orders like a board without the feature, which is the harmless direction.
   *
   * Whatever is passed here MUST be passed to `afterCursor` as well: an ordering and a cursor
   * comparison that disagree page silently wrong.
   */
  tokensEnabled = false,
): Prisma.RecommendationOrderByWithRelationInput[] {
  // The creator's picks lead every sort. Below them the chosen order applies as usual.
  const pick = { isCreatorPick: 'desc' } as const;
  // Then entries somebody spent a token on. Below a pick, because a pick is the creator's own
  // statement about their own board and a redeem is a request — when they disagree, the person
  // who owns the board wins.
  const redeemed: Prisma.RecommendationOrderByWithRelationInput[] = tokensEnabled
    ? [{ unconsumedRedeems: 'desc' }]
    : [];
  if (sort === 'newest') return [pick, ...redeemed, { createdAt: 'desc' }, { id: 'desc' }];
  if (sort === 'oldest') return [pick, ...redeemed, { createdAt: 'asc' }, { id: 'asc' }];
  // Highest first, and a card never placed by hand falls to the bottom rather than the top.
  if (sort === 'manual') {
    return [
      pick,
      ...redeemed,
      { manualRank: { sort: 'desc', nulls: 'last' } },
      { createdAt: 'desc' },
      { id: 'desc' },
    ];
  }
  return [pick, ...redeemed, { weightedScore: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }];
}

export function afterCursor(
  sort: BoardSort,
  cursor: BoardCursor,
  /**
   * MUST match what was given to `boardOrdering` for the same request. The two are derived
   * together in this file precisely because an ordering and a keyset that disagree drop rows or
   * repeat them, and every individual page still looks correct.
   */
  tokensEnabled = false,
): Prisma.RecommendationWhereInput {
  const ascending = sort === 'oldest';
  const beyond = ascending ? { gt: cursor.createdAt } : { lt: cursor.createdAt };
  const tie = ascending ? { gt: cursor.id } : { lt: cursor.id };

  if (sort === 'manual') {
    // Null ranks sort last, so once past them everything else is also null and falls back to the
    // createdAt/id tiebreak — the same shape the other sorts use, with the rank in front.
    const beyondRank: Prisma.RecommendationWhereInput[] =
      cursor.manualRank === null
        ? [
            { manualRank: null, createdAt: { lt: cursor.createdAt } },
            { manualRank: null, createdAt: cursor.createdAt, id: { lt: cursor.id } },
          ]
        : [
            { manualRank: { lt: cursor.manualRank } },
            { manualRank: null },
            { manualRank: cursor.manualRank, createdAt: { lt: cursor.createdAt } },
            { manualRank: cursor.manualRank, createdAt: cursor.createdAt, id: { lt: cursor.id } },
          ];
    return {
      OR: [
        ...(cursor.isCreatorPick ? [{ isCreatorPick: false }] : []),
        {
          isCreatorPick: cursor.isCreatorPick,
          // Dropped entirely when the ordering drops it, so the two stay the same shape.
          ...(tokensEnabled
            ? {
                OR: [
                  // Past this cursor's redeem count entirely, then within it.
                  { unconsumedRedeems: { lt: cursor.unconsumedRedeems } },
                  { unconsumedRedeems: cursor.unconsumedRedeems, OR: beyondRank },
                ],
              }
            : { OR: beyondRank }),
        },
      ],
    };
  }

  const withinPickGroup: Prisma.RecommendationWhereInput[] =
    sort === 'upvotes'
      ? [
          { weightedScore: { lt: cursor.weightedScore } },
          { weightedScore: cursor.weightedScore, createdAt: { lt: cursor.createdAt } },
          {
            weightedScore: cursor.weightedScore,
            createdAt: cursor.createdAt,
            id: { lt: cursor.id },
          },
        ]
      : [{ createdAt: beyond }, { createdAt: cursor.createdAt, id: tie }];

  return {
    OR: [
      // Picks sort first, so once past them everything unpicked follows.
      ...(cursor.isCreatorPick ? [{ isCreatorPick: false }] : []),
      {
        isCreatorPick: cursor.isCreatorPick,
        ...(tokensEnabled
          ? {
              OR: [
                // Then redeems, which sort directly below the pick — so once past this cursor's
                // redeem count, everything with fewer follows regardless of the sort beneath.
                { unconsumedRedeems: { lt: cursor.unconsumedRedeems } },
                { unconsumedRedeems: cursor.unconsumedRedeems, OR: withinPickGroup },
              ],
            }
          : { OR: withinPickGroup }),
      },
    ],
  };
}

/**
 * Design §7: staff read the whole board including the bin, patrons read only the visible
 * statuses — minus pending entries when the creator hides them, except their own.
 */
export function visibilityWhere(
  creator: { hidePendingFromPublic: boolean },
  viewer: { userId: string | null; staffRole: StaffRoleValue | null },
): Prisma.RecommendationWhereInput {
  if (viewer.staffRole !== null) return {};
  if (!creator.hidePendingFromPublic) return { status: { in: PATRON_VISIBLE_STATUSES } };
  return {
    OR: [
      { status: { in: PATRON_VISIBLE_STATUSES.filter((s) => s !== 'PENDING') } },
      // Hiding a patron's own submission from them makes the submit form look broken: success,
      // then an empty board. Anonymous has no id and so matches nothing here, which is right.
      ...(viewer.userId ? [{ status: 'PENDING' as const, submittedByUserId: viewer.userId }] : []),
    ],
  };
}

export type BoardSort = 'upvotes' | 'newest' | 'oldest' | 'manual';

export interface BoardCursor {
  weightedScore: number;
  createdAt: Date;
  id: string;
  /** Null for a card never placed by hand, which sorts last. */
  manualRank: number | null;
  /** Leads every ordering, so it has to lead the cursor comparison too. */
  isCreatorPick: boolean;
  /**
   * Sorts directly below the pick, so it compares directly below it here.
   *
   * A sort key present in `boardOrdering` and absent here breaks paging *silently*: page one is
   * correct and every page after it skips or repeats rows. That is why this field exists rather
   * than the ordering alone.
   */
  unconsumedRedeems: number;
}

export function encodeCursor(row: {
  weightedScore: number;
  createdAt: Date;
  id: string;
  isCreatorPick: boolean;
  manualRank: number | null;
  unconsumedRedeems: number;
}): string {
  return Buffer.from(
    JSON.stringify({
      u: row.weightedScore,
      m: row.manualRank,
      c: row.createdAt.toISOString(),
      i: row.id,
      p: row.isCreatorPick,
      r: row.unconsumedRedeems,
    }),
  ).toString('base64url');
}

export function decodeCursor(raw: string | undefined): BoardCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as {
      u: number;
      c: string;
      i: string;
      p?: boolean;
      m?: number | null;
      r?: number;
    };
    const createdAt = new Date(parsed.c);
    if (typeof parsed.u !== 'number' || Number.isNaN(createdAt.getTime()) || !parsed.i) {
      throw new Error('malformed');
    }
    return {
      weightedScore: parsed.u,
      manualRank: parsed.m ?? null,
      createdAt,
      id: parsed.i,
      // Absent on a cursor minted before redeems existed. Zero is what every entry on such a
      // board holds, so an old cursor keeps paging correctly rather than being rejected.
      unconsumedRedeems: parsed.r ?? 0,
      isCreatorPick: parsed.p === true,
    };
  } catch {
    // A cursor we did not mint is a client bug, not an empty board.
    throw new BadRequestException('Invalid cursor');
  }
}
