import { BadRequestException, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { Prisma, RecommendationStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BOARD_COLUMNS, BOARD_SORTS } from './dto/board-settings.dto';

/**
 * How a reader has arranged one board, kept so it follows them to their next device.
 *
 * Reads are free and writes are premium, so nothing about the page has to know whether the reader
 * pays: a free reader simply gets an empty answer, and their choices live in `localStorage` as
 * they always have. Amendment A.1 — being able to arrange the board is not withheld, only its
 * following you.
 */
@Injectable()
export class BoardSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async get(userId: string, creatorId: string) {
    const stored = await this.prisma.boardViewPreference.findUnique({
      where: { userId_creatorId: { userId, creatorId } },
      select: { collapsed: true, sorts: true },
    });
    // Absent reads as empty rather than as an error: not having arranged a board yet is the
    // normal state, and a client that has to handle a 404 for it will handle it badly.
    return {
      collapsed: stored?.collapsed ?? [],
      sorts: (stored?.sorts as Record<string, string>) ?? {},
      canSync: await this.isPremium(userId),
    };
  }

  async set(userId: string, creatorId: string, collapsed: string[], sorts: Record<string, string>) {
    if (!(await this.isPremium(userId))) {
      throw new HttpException(
        'Settings that follow you between devices are a premium feature',
        HttpStatus.PAYMENT_REQUIRED,
      );
    }
    // Checked here because `sorts` lands in a Json column: nothing downstream would reject a bad
    // value, and the first thing to notice would be a column asking the API to sort by nonsense.
    for (const [column, sort] of Object.entries(sorts)) {
      if (!(BOARD_COLUMNS as readonly string[]).includes(column)) {
        throw new BadRequestException(`Not a column: ${column}`);
      }
      if (!(BOARD_SORTS as readonly string[]).includes(sort)) {
        throw new BadRequestException(`Not a sort: ${sort}`);
      }
    }

    const data = {
      collapsed: collapsed as RecommendationStatus[],
      sorts: sorts as Prisma.InputJsonValue,
    };
    const saved = await this.prisma.boardViewPreference.upsert({
      where: { userId_creatorId: { userId, creatorId } },
      create: { userId, creatorId, ...data },
      update: data,
      select: { collapsed: true, sorts: true },
    });
    return { ...saved, canSync: true };
  }

  private async isPremium(userId: string): Promise<boolean> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { premiumUntil: true },
    });
    return user.premiumUntil !== null && user.premiumUntil > new Date();
  }
}
