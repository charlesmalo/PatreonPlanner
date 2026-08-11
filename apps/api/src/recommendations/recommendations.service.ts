import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, RecommendationStatus } from '@prisma/client';
import { ConfigService } from '../config/config.module';
import { RateLimitService } from '../limits/rate-limit.service';
import { ModerationService } from '../moderation/moderation.service';
import { PrismaService } from '../prisma/prisma.service';
import { SubmitRecommendationDto } from './dto/submit-recommendation.dto';
import { normalizeTitle } from './normalize-title';

const MAX_PAGE = 50;
// Not board-visible. DELETED is a soft delete; REJECTED is a moderation outcome that Plan 07
// will set and which should not sit on a public board.
const HIDDEN_STATUSES: RecommendationStatus[] = ['DELETED', 'REJECTED'];

interface BoardCursor {
  upvoteCount: number;
  createdAt: Date;
  id: string;
}

function encodeCursor(row: { upvoteCount: number; createdAt: Date; id: string }): string {
  return Buffer.from(
    JSON.stringify({ u: row.upvoteCount, c: row.createdAt.toISOString(), i: row.id }),
  ).toString('base64url');
}

function decodeCursor(raw: string | undefined): BoardCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as {
      u: number;
      c: string;
      i: string;
    };
    const createdAt = new Date(parsed.c);
    if (typeof parsed.u !== 'number' || Number.isNaN(createdAt.getTime()) || !parsed.i) {
      throw new Error('malformed');
    }
    return { upvoteCount: parsed.u, createdAt, id: parsed.i };
  } catch {
    // A cursor we did not mint is a client bug, not an empty board.
    throw new BadRequestException('Invalid cursor');
  }
}

// Explicit select: the submitter is a User row carrying an email and Patreon id, neither of
// which belongs on a public board.
const RECOMMENDATION_FIELDS = {
  id: true,
  type: true,
  customTitle: true,
  description: true,
  status: true,
  upvoteCount: true,
  createdAt: true,
  links: { select: { url: true, label: true } },
  submittedBy: { select: { id: true, fullName: true, avatarUrl: true } },
} satisfies Prisma.RecommendationSelect;

@Injectable()
export class RecommendationsService {
  private readonly logger = new Logger(RecommendationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly limits: RateLimitService,
    private readonly moderation: ModerationService,
    private readonly config: ConfigService,
  ) {}

  /**
   * The returned recommendation carries hasUpvoted like the board's does. Without it a client
   * prepending the result renders a card in a different shape from every other card — which is
   * precisely what the end-to-end suite caught.
   */
  async submit(creatorId: string, userId: string, dto: SubmitRecommendationDto) {
    // Rate limit first: moderation is the expensive stage, and a flood must not be able to
    // drive that cost.
    const perCreatorKey = `submit:${userId}:${creatorId}`;
    const globalKey = `submit-global:${userId}`;
    const allowed = await this.limits.consume(
      perCreatorKey,
      this.config.get('SUBMIT_LIMIT_PER_HOUR'),
      3600,
    );
    // Design §6 item 3 pairs the per-creator limit with a looser global one; without it a patron
    // of twenty creators floods at twenty an hour.
    const globallyAllowed = await this.limits.consume(
      globalKey,
      this.config.get('SUBMIT_LIMIT_PER_HOUR_GLOBAL'),
      3600,
    );
    if (!allowed || !globallyAllowed) {
      throw new HttpException('Too many submissions', HttpStatus.TOO_MANY_REQUESTS);
    }

    // Link labels and URLs are user-controlled and rendered on the board, so they go through
    // the pipeline too. Reviewing only title and description left the whole content-safety
    // control bypassable by putting the text in a label.
    const moderation = await this.moderation.review([
      dto.customTitle,
      dto.description,
      ...(dto.links?.flatMap((link) => [link.label, link.url]) ?? []),
    ]);
    if (moderation.verdict === 'BLOCK') {
      // Generic to the caller, specific in the log: design §9 wants no probing of the rules.
      this.logger.warn(`Blocked submission from user ${userId} to creator ${creatorId}`);
      throw new BadRequestException('Submission rejected');
    }

    // De-dupe after moderation, so a blocked resubmission cannot be used to confirm what
    // already exists on a board the sender cannot read.
    const normalizedTitle = normalizeTitle(dto.customTitle);
    // A title of pure punctuation carries no de-dupe key; storing '' would make every such
    // title collide.
    if (normalizedTitle.length === 0) throw new BadRequestException('Title must contain letters');
    const existing = await this.prisma.recommendation.findFirst({
      where: { creatorId, normalizedTitle, status: { notIn: HIDDEN_STATUSES } },
      select: RECOMMENDATION_FIELDS,
    });
    // Design §5: a resubmit returns the existing entry and invites an upvote rather than
    // erroring — a creator's board is a demand signal, and a 409 would lose it.
    if (existing) {
      // Refund: nothing was created, and at 1/hour charging for it would lock a patron out for
      // an hour for doing exactly what design §5 wants them to do.
      await this.refund(perCreatorKey, globalKey);
      return { duplicate: true as const, recommendation: await this.withUpvoted(existing, userId) };
    }

    try {
      return await this.create(creatorId, userId, dto, normalizedTitle);
    } catch (error) {
      // Two patrons submitting the same title concurrently both miss the read above; the unique
      // index is what actually enforces de-duplication, and the loser resolves to the winner's
      // row rather than erroring.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        await this.refund(perCreatorKey, globalKey);
        const winner = await this.prisma.recommendation.findFirstOrThrow({
          where: { creatorId, normalizedTitle },
          select: RECOMMENDATION_FIELDS,
        });
        return { duplicate: true as const, recommendation: await this.withUpvoted(winner, userId) };
      }
      throw error;
    }
  }

  /** A duplicate may already be upvoted by this viewer; a fresh one never is. */
  private async withUpvoted<T extends { id: string }>(recommendation: T, userId: string) {
    const upvote = await this.prisma.upvote.findUnique({
      where: { recommendationId_userId: { recommendationId: recommendation.id, userId } },
      select: { id: true },
    });
    return { ...recommendation, hasUpvoted: upvote !== null };
  }

  private async refund(...keys: string[]): Promise<void> {
    await Promise.all(keys.map((key) => this.limits.refund(key)));
  }

  private async create(
    creatorId: string,
    userId: string,
    dto: SubmitRecommendationDto,
    normalizedTitle: string,
  ) {
    const recommendation = await this.prisma.recommendation.create({
      data: {
        creatorId,
        submittedByUserId: userId,
        type: dto.type,
        customTitle: dto.customTitle,
        normalizedTitle,
        description: dto.description ?? null,
        links: dto.links
          ? { create: dto.links.map((l) => ({ url: l.url, label: l.label })) }
          : undefined,
      },
      select: RECOMMENDATION_FIELDS,
    });
    // Nothing can have upvoted a recommendation that did not exist a moment ago.
    return { duplicate: false as const, recommendation: { ...recommendation, hasUpvoted: false } };
  }

  async toggleUpvote(creatorId: string, recommendationId: string, userId: string) {
    // Scoped by creatorId as well as id: the guard only proved access to *this* creator, so
    // without it a patron of A could upvote an entry on B's board by guessing an id.
    const rec = await this.prisma.recommendation.findFirst({
      where: { id: recommendationId, creatorId, status: { notIn: HIDDEN_STATUSES } },
      select: { id: true },
    });
    if (!rec) throw new NotFoundException();

    // The row and the counter move together, so the number on the board cannot drift from the
    // rows behind it.
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.upvote.findUnique({
        where: { recommendationId_userId: { recommendationId, userId } },
        select: { id: true },
      });
      if (existing) {
        await tx.upvote.delete({ where: { id: existing.id } });
        const updated = await tx.recommendation.update({
          where: { id: recommendationId },
          data: { upvoteCount: { decrement: 1 } },
          select: { upvoteCount: true },
        });
        return { upvoted: false, upvoteCount: updated.upvoteCount };
      }
      await tx.upvote.create({ data: { recommendationId, userId } });
      const updated = await tx.recommendation.update({
        where: { id: recommendationId },
        data: { upvoteCount: { increment: 1 } },
        select: { upvoteCount: true },
      });
      return { upvoted: true, upvoteCount: updated.upvoteCount };
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
  async list(
    creatorId: string,
    rawCursor: string | undefined,
    limit: number | undefined,
    viewerUserId: string | null,
  ) {
    const take = Math.min(Math.max(limit ?? 20, 1), MAX_PAGE);
    const cursor = decodeCursor(rawCursor);

    const items = (await this.prisma.recommendation.findMany({
      where: {
        creatorId,
        status: { notIn: HIDDEN_STATUSES },
        ...(cursor
          ? {
              OR: [
                { upvoteCount: { lt: cursor.upvoteCount } },
                {
                  upvoteCount: cursor.upvoteCount,
                  createdAt: { lt: cursor.createdAt },
                },
                {
                  upvoteCount: cursor.upvoteCount,
                  createdAt: cursor.createdAt,
                  id: { lt: cursor.id },
                },
              ],
            }
          : {}),
      },
      orderBy: [{ upvoteCount: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      select: {
        ...RECOMMENDATION_FIELDS,
        upvoteCount: true,
        createdAt: true,
        // Whether *this* viewer upvoted. Without it a client cannot render the control's state
        // truthfully, and an optimistic toggle guesses the direction wrong.
        ...(viewerUserId
          ? { upvotes: { where: { userId: viewerUserId }, select: { id: true }, take: 1 } }
          : {}),
      },
    })) as Array<{
      id: string;
      upvoteCount: number;
      createdAt: Date;
      upvotes?: Array<{ id: string }>;
    }>;

    const hasMore = items.length > take;
    const page = hasMore ? items.slice(0, take) : items;
    const last = page[page.length - 1];
    return {
      items: page.map(({ upvotes, ...item }) => ({
        ...item,
        hasUpvoted: (upvotes ?? []).length > 0,
      })),
      nextCursor: hasMore && last ? encodeCursor(last) : null,
    };
  }
}
