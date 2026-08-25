import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AbuseService } from '../abuse/abuse.service';
import { ModerationService } from '../moderation/moderation.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';

const TICKET_FIELDS = {
  id: true,
  body: true,
  status: true,
  resolution: true,
  reply: true,
  subjectId: true,
  createdAt: true,
  resolvedAt: true,
} as const;

/**
 * A message from a reader to staff.
 *
 * A dispute ("this is season 3, not a duplicate") and general contact are the same thing with a
 * different subject — two tables would mean two inboxes, two notification types, and two sets of
 * resolution logic to drift apart.
 */
@Injectable()
export class TicketsService {
  private readonly logger = new Logger(TicketsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly moderation: ModerationService,
    private readonly abuse: AbuseService,
    private readonly notifications: NotificationsService,
  ) {}

  async raise(
    creator: { id: string; slug: string; displayName: string; allowAnonymousTickets: boolean },
    userId: string | null,
    body: string,
    subjectId?: string,
  ) {
    if (!userId && !creator.allowAnonymousTickets) {
      throw new ForbiddenException('This board takes messages from signed-in readers only');
    }

    // Scoped by creator: a subject on another board must not be attachable here, and a bare 404
    // says nothing about whether that id exists elsewhere.
    if (subjectId) {
      const subject = await this.prisma.recommendation.findFirst({
        where: { id: subjectId, creatorId: creator.id },
        select: { id: true },
      });
      if (!subject) throw new NotFoundException();
    }

    // Attacker-chosen text a moderator will read. Design §6.5 exempts nothing.
    const verdict = await this.moderation.review(
      { creatorId: creator.id, userId: userId ?? SYSTEM_AUTHOR, type: 'FLAG_NOTE', id: subjectId },
      [body],
    );
    if (verdict.verdict === 'BLOCK') {
      this.logger.warn(`Blocked ticket on creator ${creator.id}`);
      if (userId) {
        try {
          await this.abuse.strike(userId, 'MODERATION_BLOCK');
        } catch (error) {
          this.logger.warn(`Could not record a strike for user ${userId}: ${String(error)}`);
        }
      }
      throw new BadRequestException('Message rejected');
    }

    const recipients = await this.staffToNotify(creator.id, userId);
    return this.prisma.$transaction(async (tx) => {
      const ticket = await tx.ticket.create({
        data: { creatorId: creator.id, raisedByUserId: userId, subjectId: subjectId ?? null, body },
        select: TICKET_FIELDS,
      });
      // In the same transaction as the ticket, like every other notification here: one telling
      // staff about a message that was rolled back is a lie.
      await this.notifications.emit(
        tx,
        recipients.map((recipient) => ({
          userId: recipient,
          creatorId: creator.id,
          type: 'TICKET_RAISED' as const,
          payload: {
            recommendationId: subjectId ?? '',
            title: subjectId ? 'an entry' : 'the board',
            creatorSlug: creator.slug,
            creatorName: creator.displayName,
            ticketId: ticket.id,
          },
        })),
      );
      return ticket;
    });
  }

  async list(creatorId: string, status: 'OPEN' | 'RESOLVED' = 'OPEN') {
    const items = await this.prisma.ticket.findMany({
      where: { creatorId, status },
      select: {
        ...TICKET_FIELDS,
        raisedBy: { select: { id: true, fullName: true, avatarUrl: true } },
        subject: { select: { id: true, customTitle: true, status: true } },
      },
      // Oldest first: a ticket must not rot while newer ones arrive above it. The same reasoning
      // the review queue carries.
      orderBy: { createdAt: 'asc' },
      take: 50,
    });
    return { items };
  }

  async resolve(
    creator: { id: string; slug: string; displayName: string },
    id: string,
    actorUserId: string,
    resolution: 'CONFIRMED' | 'DENIED' | 'LINKED' | 'CLOSED',
    reply?: string,
  ) {
    // Scoped by creator as well as id: a ticket id alone says nothing about which board owns it.
    const ticket = await this.prisma.ticket.findFirst({
      where: { id, creatorId: creator.id },
      select: { id: true, raisedByUserId: true, subjectId: true },
    });
    if (!ticket) throw new NotFoundException();

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.ticket.update({
        where: { id: ticket.id },
        data: {
          status: 'RESOLVED',
          resolution,
          reply: reply ?? null,
          resolvedByUserId: actorUserId,
          resolvedAt: new Date(),
        },
        select: TICKET_FIELDS,
      });

      // The reader hears the answer through the notification system rather than by email:
      // email is out of Phase 1 and out of the free-tier constraint.
      if (ticket.raisedByUserId && ticket.raisedByUserId !== actorUserId) {
        await this.notifications.emit(tx, [
          {
            userId: ticket.raisedByUserId,
            creatorId: creator.id,
            type: 'TICKET_RESOLVED' as const,
            payload: {
              recommendationId: ticket.subjectId ?? '',
              title: 'your message',
              creatorSlug: creator.slug,
              creatorName: creator.displayName,
              ticketId: ticket.id,
              resolution,
              reply: reply ?? undefined,
            },
          },
        ]);
      }
      return updated;
    });
  }

  /**
   * Whoever would actually work it — staff holding HANDLE_REPORTS, and the owner, who holds
   * every permission by role. Never the person who raised it.
   */
  private async staffToNotify(creatorId: string, raiserId: string | null): Promise<string[]> {
    const [creator, staff] = await Promise.all([
      this.prisma.creator.findUniqueOrThrow({
        where: { id: creatorId },
        select: { ownerUserId: true },
      }),
      this.prisma.creatorStaff.findMany({
        where: { creatorId, permissions: { has: 'HANDLE_REPORTS' } },
        select: { userId: true },
      }),
    ]);
    const ids = new Set([creator.ownerUserId, ...staff.map((row) => row.userId)]);
    if (raiserId) ids.delete(raiserId);

    // Coalesced like flag notifications: someone who has not looked at the last message does not
    // need telling about the next one.
    const waiting = await this.prisma.notification.findMany({
      where: { creatorId, type: 'TICKET_RAISED', readAt: null, userId: { in: [...ids] } },
      select: { userId: true },
      distinct: ['userId'],
    });
    for (const row of waiting) ids.delete(row.userId);
    return [...ids];
  }
}

/** Moderation records need an author; an anonymous message has none. */
const SYSTEM_AUTHOR = '00000000-0000-0000-0000-000000000000';
