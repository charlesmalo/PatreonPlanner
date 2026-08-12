import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { FlagStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ModerationService } from './moderation.service';

const MAX_PAGE = 50;

@Injectable()
export class ReviewQueueService {
  private readonly logger = new Logger(ReviewQueueService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly moderation: ModerationService,
  ) {}

  /**
   * Design §7's review queue: flagged entries first, then the rest oldest-first, including
   * REJECTED and DELETED so the bin is reachable.
   *
   * A read model of its own rather than a flag on the board query — the board hides statuses
   * this shows and hides the submitter this exposes, and one query serving two visibility rules
   * is how a leak gets written.
   */
  async list(creatorId: string, offset = 0, limit = 20) {
    const take = Math.min(Math.max(limit, 1), MAX_PAGE);
    const items = await this.prisma.recommendation.findMany({
      where: { creatorId },
      select: {
        id: true,
        customTitle: true,
        description: true,
        status: true,
        upvoteCount: true,
        createdAt: true,
        submittedBy: { select: { id: true, fullName: true, avatarUrl: true } },
        flags: {
          where: { status: 'OPEN' },
          select: {
            id: true,
            reason: true,
            note: true,
            createdAt: true,
            flaggedBy: { select: { id: true, fullName: true } },
          },
          orderBy: { createdAt: 'asc' },
        },
        _count: { select: { flags: { where: { status: 'OPEN' } } } },
      },
      // "Multiple flags raise priority" (design §6.6). Postgres orders by the counted relation,
      // so the queue does not have to be sorted in memory after a paged read — which would sort
      // only the page and put the wrong entries on it.
      orderBy: [{ flags: { _count: 'desc' } }, { createdAt: 'asc' }],
      skip: offset,
      take: take + 1,
    });

    const hasMore = items.length > take;
    const page = hasMore ? items.slice(0, take) : items;
    return {
      items: page.map(({ _count, ...item }) => ({ ...item, openFlagCount: _count.flags })),
      nextOffset: hasMore ? offset + take : null,
    };
  }

  /**
   * Design §6.6's edit/redact. The previous text survives only in the audit row: keeping it on
   * the recommendation for display would defeat the point of redacting it.
   */
  async redact(
    creatorId: string,
    recommendationId: string,
    actorUserId: string,
    changes: { customTitle?: string; description?: string },
    note?: string,
  ) {
    const fields = Object.entries(changes).filter(([, value]) => value !== undefined);
    if (fields.length === 0) {
      // Otherwise every empty PATCH writes an audit row claiming an edit that did not happen.
      throw new BadRequestException('No fields to change');
    }

    const current = await this.prisma.recommendation.findFirst({
      where: { id: recommendationId, creatorId },
      select: { id: true, customTitle: true, description: true },
    });
    if (!current) throw new NotFoundException();

    // A moderator's replacement text is still text on a public board. Design §6.5 runs it
    // through the same pipeline as a patron's.
    const verdict = await this.moderation.review(fields.map(([, value]) => value as string));
    if (verdict.verdict === 'BLOCK') {
      this.logger.warn(`Blocked redaction by ${actorUserId} on recommendation ${recommendationId}`);
      throw new BadRequestException('Rejected');
    }

    const before = Object.fromEntries(
      fields.map(([key]) => [key, current[key as keyof typeof changes] ?? null]),
    );
    const after = Object.fromEntries(fields);

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.recommendation.update({
        where: { id: recommendationId },
        data: after,
        select: { id: true, customTitle: true, description: true, status: true },
      });
      await tx.moderationAction.create({
        data: {
          recommendationId,
          actorUserId,
          action: 'EDIT',
          note: note ?? null,
          before,
          after,
        },
      });
      return updated;
    });
  }

  /** Design §6.6: resolve or dismiss, audited like every other moderator action. */
  async resolveFlag(
    creatorId: string,
    flagId: string,
    actorUserId: string,
    status: FlagStatus,
    note?: string,
  ) {
    if (status === 'OPEN') {
      // Reopening is not a moderator action the design defines, and allowing it would let the
      // priority signal be inflated by staff rather than by reporters.
      throw new BadRequestException('A flag cannot be reopened');
    }

    // A flag id alone says nothing about which board it belongs to; the join is what scopes it.
    const flag = await this.prisma.flag.findFirst({
      where: { id: flagId, recommendation: { creatorId } },
      select: { id: true, status: true, recommendationId: true },
    });
    if (!flag) throw new NotFoundException();

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.flag.update({
        where: { id: flagId },
        data: { status, resolvedByUserId: actorUserId, resolvedAt: new Date() },
        select: { id: true, status: true, resolvedAt: true },
      });
      await tx.moderationAction.create({
        data: {
          recommendationId: flag.recommendationId,
          actorUserId,
          action: status === 'RESOLVED' ? 'FLAG_RESOLVED' : 'FLAG_DISMISSED',
          note: note ?? null,
          before: { flagId, status: flag.status },
          after: { flagId, status },
        } satisfies Prisma.ModerationActionUncheckedCreateInput,
      });
      return updated;
    });
  }
}
