import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { FlagReason, Prisma } from '@prisma/client';
import { AbuseService } from '../abuse/abuse.service';
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
      select: { id: true },
    });
    if (!rec) throw new NotFoundException();

    // The note is attacker-chosen text that a moderator will read. Design §6.5 puts every user
    // string through the pipeline, and a report is not an exemption from it.
    const verdict = await this.moderation.review([note]);
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
      const flag = await this.prisma.flag.create({
        data: { recommendationId, flaggedByUserId: userId, reason, note: note ?? null },
        select: FLAG_FIELDS,
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
}
