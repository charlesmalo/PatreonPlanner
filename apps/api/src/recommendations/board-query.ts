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
export function boardOrdering(sort: BoardSort): Prisma.RecommendationOrderByWithRelationInput[] {
  // The creator's picks lead every sort. Below them the chosen order applies as usual.
  const pick = { isCreatorPick: 'desc' } as const;
  if (sort === 'newest') return [pick, { createdAt: 'desc' }, { id: 'desc' }];
  if (sort === 'oldest') return [pick, { createdAt: 'asc' }, { id: 'asc' }];
  // Highest first, and a card never placed by hand falls to the bottom rather than the top.
  if (sort === 'manual') {
    return [
      pick,
      { manualRank: { sort: 'desc', nulls: 'last' } },
      { createdAt: 'desc' },
      { id: 'desc' },
    ];
  }
  return [pick, { weightedScore: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }];
}

export function afterCursor(sort: BoardSort, cursor: BoardCursor): Prisma.RecommendationWhereInput {
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
        { isCreatorPick: cursor.isCreatorPick, OR: beyondRank },
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
      { isCreatorPick: cursor.isCreatorPick, OR: withinPickGroup },
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
}

export function encodeCursor(row: {
  weightedScore: number;
  createdAt: Date;
  id: string;
  isCreatorPick: boolean;
  manualRank: number | null;
}): string {
  return Buffer.from(
    JSON.stringify({
      u: row.weightedScore,
      m: row.manualRank,
      c: row.createdAt.toISOString(),
      i: row.id,
      p: row.isCreatorPick,
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
      isCreatorPick: parsed.p === true,
    };
  } catch {
    // A cursor we did not mint is a client bug, not an empty board.
    throw new BadRequestException('Invalid cursor');
  }
}
