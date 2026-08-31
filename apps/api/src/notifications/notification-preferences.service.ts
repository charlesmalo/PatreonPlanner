import { BadRequestException, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { RecommendationStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DEFAULT_MOVE_STATUSES } from './board-followers.service';
import type { NotifiableStatus } from './dto/notification-preferences.dto';

@Injectable()
export class NotificationPreferencesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * What this reader currently hears from this board, and whether that is a choice or the default.
   *
   * `isDefault` is part of the contract rather than something a client infers by comparing to the
   * default set: a client that cannot tell "I have not chosen" from "I chose exactly the default"
   * renders an empty form and invites someone to re-pick what they already have — and would be
   * wrong the moment the default changes.
   */
  async get(userId: string, creatorId: string) {
    const [preference, user] = await Promise.all([
      this.prisma.boardNotificationPreference.findUnique({
        where: { userId_creatorId: { userId, creatorId } },
        select: { statuses: true, themeIds: true },
      }),
      this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { premiumUntil: true, emailDigest: true },
      }),
    ]);

    return {
      statuses: preference ? preference.statuses : DEFAULT_MOVE_STATUSES,
      themeIds: preference?.themeIds ?? [],
      isDefault: preference === null,
      canCustomise: isPremium(user.premiumUntil),
      // Read here so the settings page needs one request rather than two. Written elsewhere: the
      // digest covers every board, so it is not a per-board preference.
      emailDigest: user.emailDigest,
    };
  }

  /**
   * Replaces the set outright. Amendment A.1: being notified is free forever and only the
   * granularity is bought, so a free reader is refused rather than silently ignored — a no-op
   * would leave them believing they had configured something.
   */
  async set(
    userId: string,
    creatorId: string,
    statuses: NotifiableStatus[],
    themeIds: string[] = [],
  ) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { premiumUntil: true },
    });
    if (!isPremium(user.premiumUntil)) {
      throw new HttpException(
        'Choosing which moves reach you is a premium feature',
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    // Scoped to this board: a theme id from elsewhere would narrow to nothing at fan-out time
    // anyway, but storing it means the settings page renders a choice that does not exist here.
    if (themeIds.length > 0) {
      const theirs = await this.prisma.theme.count({
        where: { creatorId, id: { in: themeIds } },
      });
      if (theirs !== themeIds.length) {
        throw new BadRequestException('That is not a theme on this board');
      }
    }

    const asStatuses = statuses as RecommendationStatus[];
    const preference = await this.prisma.boardNotificationPreference.upsert({
      where: { userId_creatorId: { userId, creatorId } },
      create: { userId, creatorId, statuses: asStatuses, themeIds },
      update: { statuses: asStatuses, themeIds },
      select: { statuses: true, themeIds: true },
    });
    return {
      statuses: preference.statuses,
      themeIds: preference.themeIds,
      isDefault: false,
      canCustomise: true,
    };
  }
}

/** Absent or past means no. Compared at read time, so an expired subscription lapses on its own. */
function isPremium(premiumUntil: Date | null): boolean {
  return premiumUntil !== null && premiumUntil > new Date();
}
