import { Injectable } from '@nestjs/common';
import { FlagReason, NotificationType, Prisma, RecommendationStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export const NOTIFICATION_PAGE_SIZE = 20;

/**
 * Everything the SPA needs to render the message without asking a second question. Denormalised on
 * purpose — see the note on `Notification.payload` in the schema.
 */
export interface NotificationPayload {
  recommendationId: string;
  title: string;
  creatorSlug: string;
  creatorName: string;
  status?: RecommendationStatus;
  reason?: FlagReason;
}

export interface EmitRow {
  userId: string;
  creatorId: string;
  type: NotificationType;
  payload: NotificationPayload;
}

/** Anything that can run a write — the caller's transaction, or the client itself. */
type Writer = Pick<Prisma.TransactionClient, 'notification'>;

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Takes the caller's transaction rather than reaching for its own client. The same reasoning
   * `ModerationActionsService` carries for its audit row: a notification for a transition that
   * rolled back is a lie, and a transition nobody was told about is a silent one. Emitting outside
   * the event's transaction produces one or the other depending on which side fails.
   */
  async emit(tx: Writer, rows: EmitRow[]): Promise<void> {
    if (rows.length === 0) return;
    await tx.notification.createMany({
      data: rows.map((row) => ({
        ...row,
        payload: row.payload as unknown as Prisma.InputJsonValue,
      })),
    });
  }

  /**
   * Keyset rather than offset: this list grows at the head, so by the time a reader asks for page
   * two an offset would hand them a row page one already carried.
   */
  async list(userId: string, cursor?: string, limit = NOTIFICATION_PAGE_SIZE) {
    const rows = await this.prisma.notification.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const items = rows.slice(0, limit);
    return {
      items,
      nextCursor: rows.length > limit ? items[items.length - 1].id : null,
    };
  }

  unreadCount(userId: string): Promise<number> {
    return this.prisma.notification.count({ where: { userId, readAt: null } });
  }

  /**
   * Scoped by userId as well as id: an id alone says nothing about whose notification it is, and
   * this is the one endpoint that takes ids straight from a request body.
   */
  async markRead(userId: string, ids?: string[]): Promise<number> {
    const { count } = await this.prisma.notification.updateMany({
      where: { userId, readAt: null, ...(ids ? { id: { in: ids } } : {}) },
      data: { readAt: new Date() },
    });
    return count;
  }
}
