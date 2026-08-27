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
  /** Tickets only: which one, and what staff decided about it. */
  ticketId?: string;
  resolution?: string;
  reply?: string;
}

export interface EmitRow {
  userId: string;
  creatorId: string;
  type: NotificationType;
  payload: NotificationPayload;
  /** See `SEVERITY_BY_REASON`. Omitted means news rather than a problem. */
  severity?: number;
}

/**
 * How urgently a report wants working, most serious first.
 *
 * Harassment targets a person and time matters. Sexual content may break the law or the platform's
 * terms and is publicly visible. Spam degrades a board without a victim. Off-topic is curation,
 * duplicate is housekeeping. OTHER sits at the bottom deliberately: an unclassified report must
 * not outrank one whose seriousness is known.
 */
/**
 * A ticket ranks above a status change and below a report: someone has taken the trouble to
 * write, but nothing has been reported as wrong with the board.
 */
export const TICKET_SEVERITY = 15;

export const SEVERITY_BY_REASON: Record<string, number> = {
  HARASSMENT: 50,
  SEXUAL_CONTENT: 40,
  SPAM: 30,
  OFF_TOPIC: 20,
  DUPLICATE: 10,
  OTHER: 5,
};

export interface ListOptions {
  type?: NotificationType;
  unreadOnly?: boolean;
  sort?: 'newest' | 'oldest' | 'severity';
}

/** Anything that can run a write — the caller's transaction, or the client itself. */
type Writer = Pick<Prisma.TransactionClient, 'notification'>;

/** Coalescing needs raw SQL as well as the model, to keep the whole fan-out to two statements. */
type RawWriter = Writer & Pick<Prisma.TransactionClient, '$executeRaw'>;

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Takes the caller's transaction rather than reaching for its own client. The same reasoning
   * `ModerationActionsService` carries for its audit row: a notification for a transition that
   * rolled back is a lie, and a transition nobody was told about is a silent one. Emitting outside
   * the event's transaction produces one or the other depending on which side fails.
   */
  /**
   * Emits one notification per recipient, folding it into whatever they already have waiting for
   * this board.
   *
   * A creator working through their queue moves eight entries in one sitting. Without this, every
   * follower gets eight bell items for one act of tidying, and the most recent — the one they
   * actually care about — is buried under seven older ones.
   *
   * `flags.service.ts` coalesces by *dropping* repeat recipients, and is right to: reports are
   * read in the review queue, so its bell only has to say something is waiting. That does not
   * transfer here, where the notification is the thing itself. Suppression would leave a reader
   * who checks weekly seeing the first move of the week and never the newest.
   *
   * Two statements regardless of how many people follow the board. A per-recipient read would
   * satisfy every test and fall over at the only scale that matters.
   */
  async emitCoalesced(tx: RawWriter, rows: EmitRow[]): Promise<void> {
    if (rows.length === 0) return;
    // One board, one payload, one type per call — the fan-out for a single event.
    const { creatorId, type, payload } = rows[0];
    const userIds = rows.map((row) => row.userId);

    const folded = await tx.$executeRaw`
      UPDATE "Notification"
         SET payload = ${payload}::jsonb,
             "groupCount" = "groupCount" + 1,
             -- The bell sorts on createdAt, and a rewritten row is genuinely fresh news. Left
             -- alone it sinks below older, less interesting items. The cost is that createdAt
             -- now means "last folded into" rather than "created".
             "createdAt" = now()
       WHERE "creatorId" = ${creatorId}::uuid
         AND "type" = ${type}::"NotificationType"
         AND "readAt" IS NULL
         AND "userId" = ANY(${userIds}::uuid[])`;

    if (folded === userIds.length) return;

    // Whoever the UPDATE did not touch. Scoped by the same predicate so the two cannot disagree.
    const alreadyWaiting = await tx.notification.findMany({
      where: { creatorId, type, readAt: null, userId: { in: userIds } },
      select: { userId: true },
      distinct: ['userId'],
    });
    const waiting = new Set(alreadyWaiting.map((row) => row.userId));

    await this.emit(
      tx,
      rows.filter((row) => !waiting.has(row.userId)),
    );
  }

  async emit(tx: Writer, rows: EmitRow[]): Promise<void> {
    if (rows.length === 0) return;
    await tx.notification.createMany({
      data: rows.map((row) => ({
        ...row,
        severity:
          row.severity ??
          SEVERITY_BY_REASON[row.payload.reason ?? ''] ??
          (row.type === 'TICKET_RAISED' ? TICKET_SEVERITY : 0),
        payload: row.payload as unknown as Prisma.InputJsonValue,
      })),
    });
  }

  /**
   * Keyset rather than offset: this list grows at the head, so by the time a reader asks for page
   * two an offset would hand them a row page one already carried.
   */
  async list(
    userId: string,
    cursor?: string,
    limit = NOTIFICATION_PAGE_SIZE,
    options: ListOptions = {},
  ) {
    const rows = await this.prisma.notification.findMany({
      where: {
        userId,
        ...(options.type ? { type: options.type } : {}),
        ...(options.unreadOnly ? { readAt: null } : {}),
      },
      // Every ordering ends in id, so it is total — without that a cursor cannot resume from a
      // stable position when two rows share a timestamp.
      orderBy: orderingFor(options.sort),
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

function orderingFor(sort: ListOptions['sort']): Prisma.NotificationOrderByWithRelationInput[] {
  if (sort === 'oldest') return [{ createdAt: 'asc' }, { id: 'asc' }];
  if (sort === 'severity') {
    return [{ severity: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }];
  }
  return [{ createdAt: 'desc' }, { id: 'desc' }];
}
