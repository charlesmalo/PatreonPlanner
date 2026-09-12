import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ModerationActionType, RecommendationStatus } from '@prisma/client';
import { BoardFollowersService } from '../notifications/board-followers.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { isLegalTransition } from './transitions';

@Injectable()
export class ModerationActionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly followers: BoardFollowersService,
  ) {}

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
      select: {
        id: true,
        status: true,
        // The rest is for the notification payload, which is a snapshot rather than a join.
        submittedByUserId: true,
        customTitle: true,
        creator: { select: { slug: true, displayName: true } },
        // Scoped to this creator: themes are per board, and another creator's must not decide who
        // hears about this move. Empty for an entry with no catalogue title.
        title: {
          select: { themes: { where: { theme: { creatorId } }, select: { themeId: true } } },
        },
      },
    });
    if (!current) throw new NotFoundException();
    if (!isLegalTransition(current.status, to)) {
      throw new ConflictException(`Cannot move from ${current.status} to ${to}`);
    }

    return this.prisma.$transaction(async (tx) => {
      // Conditional on the status the transition was checked against. An unconditional update
      // let two concurrent moderators both read PENDING, both pass the map, and both write —
      // ending at ACCEPTED via REJECTED, a move the map forbids, with an audit row claiming a
      // `before` that was no longer true when the write landed.
      const { count } = await tx.recommendation.updateMany({
        where: { id: recommendationId, creatorId, status: current.status },
        data: { status: to },
      });
      if (count === 0) {
        // Carries a machine-readable reason, the way the submit timeout carries `retryAt`: this
        // endpoint answers 409 for two things needing opposite remedies. An illegal transition
        // means pick a different move; this means somebody else already moved it, and the move
        // you asked for may be perfectly legal from where it is now. A client that cannot tell
        // them apart has to guess, and guessing "not allowed" sends a moderator looking for the
        // wrong problem. The prose stays unread by the client — only `reason` is.
        throw new ConflictException({
          message: 'That entry changed while you were looking at it',
          reason: 'STALE',
        });
      }
      const updated = { id: recommendationId, status: to };
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
      // In the same transaction, for the same reason the audit row is: a notification telling
      // someone their entry was accepted, when the move it describes was rolled back, is worse
      // than no notification at all. Not sent to the actor — a moderator who moves their own
      // entry already knows.
      const payload = {
        recommendationId,
        title: current.customTitle,
        creatorSlug: current.creator.slug,
        creatorName: current.creator.displayName,
        status: to,
      };
      if (current.submittedByUserId !== actorUserId) {
        await this.notifications.emit(tx, [
          {
            userId: current.submittedByUserId,
            creatorId,
            type: 'ENTRY_STATUS_CHANGED',
            payload,
          },
        ]);
      }

      // Amendment A.4: everyone following the board hears the moves they asked to hear about.
      // In the same transaction as the move itself, for the reason above — and excluding the two
      // people already accounted for, because the submitter has just been told and a moderator
      // moving something knows what they moved.
      const audience = await this.followers.audienceFor(
        tx,
        creatorId,
        to,
        [actorUserId, current.submittedByUserId],
        (current.title?.themes ?? []).map((link) => link.themeId),
        recommendationId,
      );
      // Coalesced: a creator tidying eight entries into Now Playing is one act, not eight pieces
      // of news in every follower's bell.
      await this.notifications.emitCoalesced(
        tx,
        audience.map((userId) => ({
          userId,
          creatorId,
          type: 'ENTRY_MOVED' as const,
          payload,
        })),
      );
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
