import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ConfigService } from '../config/config.module';
import { RateLimitService } from '../limits/rate-limit.service';
import { ModerationService } from '../moderation/moderation.service';
import { PrismaService } from '../prisma/prisma.service';
import { SubmitRecommendationDto } from './dto/submit-recommendation.dto';
import { normalizeTitle } from './normalize-title';

const MAX_PAGE = 50;

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

  async submit(creatorId: string, userId: string, dto: SubmitRecommendationDto) {
    // Rate limit first: moderation is the expensive stage, and a flood must not be able to
    // drive that cost.
    const allowed = await this.limits.consume(
      `submit:${userId}:${creatorId}`,
      this.config.get('SUBMIT_LIMIT_PER_HOUR'),
      3600,
    );
    if (!allowed) {
      throw new HttpException('Too many submissions', HttpStatus.TOO_MANY_REQUESTS);
    }

    const moderation = await this.moderation.review([dto.customTitle, dto.description]);
    if (moderation.verdict === 'BLOCK') {
      // Generic to the caller, specific in the log: design §9 wants no probing of the rules.
      this.logger.warn(`Blocked submission from user ${userId} to creator ${creatorId}`);
      throw new BadRequestException('Submission rejected');
    }

    // De-dupe after moderation, so a blocked resubmission cannot be used to confirm what
    // already exists on a board the sender cannot read.
    const normalizedTitle = normalizeTitle(dto.customTitle);
    const existing = await this.prisma.recommendation.findFirst({
      where: { creatorId, normalizedTitle, status: { not: 'DELETED' } },
      select: RECOMMENDATION_FIELDS,
    });
    // Design §5: a resubmit returns the existing entry and invites an upvote rather than
    // erroring — a creator's board is a demand signal, and a 409 would lose it.
    if (existing) return { duplicate: true as const, recommendation: existing };

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
    return { duplicate: false as const, recommendation };
  }

  async toggleUpvote(creatorId: string, recommendationId: string, userId: string) {
    // Scoped by creatorId as well as id: the guard only proved access to *this* creator, so
    // without it a patron of A could upvote an entry on B's board by guessing an id.
    const rec = await this.prisma.recommendation.findFirst({
      where: { id: recommendationId, creatorId, status: { not: 'DELETED' } },
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
   * Keyset pagination on (upvoteCount, createdAt, id). Offset paging would shift under
   * concurrent upvoting and show or skip entries mid-scroll.
   */
  async list(creatorId: string, cursor: string | undefined, limit: number | undefined) {
    const take = Math.min(Math.max(limit ?? 20, 1), MAX_PAGE);
    const items = await this.prisma.recommendation.findMany({
      where: { creatorId, status: { not: 'DELETED' } },
      orderBy: [{ upvoteCount: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      take: take + 1,
      select: RECOMMENDATION_FIELDS,
    });

    const hasMore = items.length > take;
    return {
      items: hasMore ? items.slice(0, take) : items,
      nextCursor: hasMore ? items[take - 1].id : null,
    };
  }
}
