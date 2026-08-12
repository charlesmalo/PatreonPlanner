import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ModerationActionType, RecommendationStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { isLegalTransition } from './transitions';

@Injectable()
export class ModerationActionsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Design §7: only staff move an entry, every transition is audited, and the audit row is
   * written in the same transaction as the change — an audit log that can be missing the row for
   * something that happened is not an audit log, and a status write outside the transaction is
   * exactly how that gap appears.
   */
  async changeStatus(
    creatorId: string,
    recommendationId: string,
    actorUserId: string,
    to: RecommendationStatus,
    note?: string,
  ) {
    // Scoped by creatorId: the guard proved access to this creator, not to this id.
    const current = await this.prisma.recommendation.findFirst({
      where: { id: recommendationId, creatorId },
      select: { id: true, status: true },
    });
    if (!current) throw new NotFoundException();
    if (!isLegalTransition(current.status, to)) {
      throw new ConflictException(`Cannot move from ${current.status} to ${to}`);
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.recommendation.update({
        where: { id: recommendationId },
        data: { status: to },
        select: { id: true, status: true },
      });
      await tx.moderationAction.create({
        data: {
          recommendationId,
          actorUserId,
          action: actionFor(current.status, to),
          note: note ?? null,
          before: { status: current.status },
          after: { status: to },
        },
      });
      return updated;
    });
  }
}

/**
 * Removal and restoration read differently from an ordinary move on a review screen, so they get
 * their own action types rather than every row saying STATUS_CHANGE.
 */
function actionFor(from: RecommendationStatus, to: RecommendationStatus): ModerationActionType {
  if (to === 'DELETED') return 'DELETE';
  if (from === 'DELETED' || from === 'REJECTED') return 'RESTORE';
  return 'STATUS_CHANGE';
}
