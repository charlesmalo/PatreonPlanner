import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { FlagReason, Prisma } from '@prisma/client';
import { AbuseService } from '../abuse/abuse.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { ModerationService } from './moderation.service';

const FLAG_FIELDS = {
  id: true,
  reason: true,
  status: true,
  createdAt: true,
} satisfies Prisma.FlagSelect;

@Injectable()
export class FlagsService {
  private readonly logger = new Logger(FlagsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly moderation: ModerationService,
    private readonly abuse: AbuseService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Design §6.6: any eligible viewer reports an entry, and the report lands in the creator's
   * review queue. One flag per person per entry — the unique index is what enforces it, since
   * two concurrent reports both miss a read-then-write check.
   */
  async raise(
    creatorId: string,
    recommendationId: string,
    userId: string,
    reason: FlagReason,
    note?: string,
  ) {
    // Scoped by creatorId: the guard proved access to this creator, not to this id.
    const rec = await this.prisma.recommendation.findFirst({
      where: { id: recommendationId, creatorId },
      select: { id: true, customTitle: true },
    });
    if (!rec) throw new NotFoundException();

    // The note is attacker-chosen text that a moderator will read. Design §6.5 puts every user
    // string through the pipeline, and a report is not an exemption from it.
    const verdict = await this.moderation.review(
      { creatorId, userId, type: 'FLAG_NOTE', id: recommendationId },
      [note],
    );
    if (verdict.verdict === 'BLOCK') {
      this.logger.warn(`Blocked flag note from user ${userId} on recommendation ${rec.id}`);
      // Design §6.5: a BLOCK is a strike wherever the pipeline runs. Without this, flag notes
      // were a free oracle — an abuser could binary-search the blocklist here at no cost, then
      // craft a submission that passes the check that *does* cost them.
      try {
        await this.abuse.strike(userId, 'MODERATION_BLOCK');
      } catch (error) {
        this.logger.warn(`Could not record a strike for user ${userId}: ${String(error)}`);
      }
      throw new BadRequestException('Report rejected');
    }

    try {
      const recipients = await this.staffToNotify(creatorId, userId);
      const flag = await this.prisma.$transaction(async (tx) => {
        const created = await tx.flag.create({
          data: { recommendationId, flaggedByUserId: userId, reason, note: note ?? null },
          select: FLAG_FIELDS,
        });
        // Inside the transaction, so the unique index that makes a repeat report idempotent also
        // makes the notifications idempotent. Emitting afterwards would let one reporter ring
        // every moderator's bell as often as they liked.
        await this.notifications.emit(
          tx,
          recipients.map(({ userId: recipient, slug, displayName }) => ({
            userId: recipient,
            creatorId,
            type: 'ENTRY_FLAGGED' as const,
            payload: {
              recommendationId,
              title: rec.customTitle,
              creatorSlug: slug,
              creatorName: displayName,
              reason,
            },
          })),
        );
        return created;
      });
      return { duplicate: false as const, ...flag };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        // A repeat report returns the standing one rather than erroring, matching how a repeat
        // submission behaves: the user's intent is already recorded.
        const existing = await this.prisma.flag.findUniqueOrThrow({
          where: {
            recommendationId_flaggedByUserId: { recommendationId, flaggedByUserId: userId },
          },
          select: FLAG_FIELDS,
        });
        return { duplicate: true as const, ...existing };
      }
      throw error;
    }
  }

  /**
   * Design §6.6: a report notifies the creator and their verified mods. `CreatorStaff` has one
   * write path — accepting an invite — and removal deletes the row, so every row here is a
   * verified mod. Claiming a board also writes an OWNER row, so the owner is normally in that
   * set; the union is belt and braces for any board that predates it, and a mod may be the
   * person reporting, so both are deduped.
   *
   * Inline rather than queued: a board has an owner and a handful of mods, and a job for a
   * fan-out of five is machinery with its own failure modes that would also put the write outside
   * the flag's transaction.
   */
  private async staffToNotify(creatorId: string, reporterId: string) {
    const creator = await this.prisma.creator.findUniqueOrThrow({
      where: { id: creatorId },
      select: { ownerUserId: true, slug: true, displayName: true },
    });
    const staff = await this.prisma.creatorStaff.findMany({
      where: { creatorId },
      select: { userId: true },
    });
    const ids = new Set([creator.ownerUserId, ...staff.map((row) => row.userId)]);
    ids.delete(reporterId);

    // Coalesced: a moderator who has not yet looked at the last report does not need to be told
    // about the next one. Raising a flag costs a signed-in account almost nothing and there are
    // as many entries to flag as the board has, so without this one patron can put a notification
    // per entry in front of every moderator. The review queue is where reports are read; the bell
    // only has to say that something is waiting.
    const alreadyWaiting = await this.prisma.notification.findMany({
      where: { creatorId, type: 'ENTRY_FLAGGED', readAt: null, userId: { in: [...ids] } },
      select: { userId: true },
      distinct: ['userId'],
    });
    for (const row of alreadyWaiting) ids.delete(row.userId);

    return [...ids].map((userId) => ({
      userId,
      slug: creator.slug,
      displayName: creator.displayName,
    }));
  }
}
