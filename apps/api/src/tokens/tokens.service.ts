import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { periodKeyFor } from './period-key';

/**
 * Granting and holding redeem tokens.
 *
 * **Granting is lazy: it happens when a balance is read, not from a scheduled job.** A monthly
 * fan-out over every creator's membership list is the most expensive thing this product could
 * run, fires when nobody is watching, and retries into exactly the double-grant the unique
 * constraint exists to prevent. Granting on read does the same work spread across the month, only
 * for readers who actually look, and each grant is one insert.
 *
 * The cost, stated plainly: a reader who never opens the board accrues nothing until they do, and
 * is then granted the current period only. Back-granting every missed month would hand somebody a
 * year of tokens for returning, which is a windfall rather than a thank-you.
 */
@Injectable()
export class TokensService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Grants this period's tokens if they are due and not already granted.
   *
   * Safe to call as often as anything likes — that is the whole design. The guarantee is the
   * unique index on `(creatorId, userId, periodKey)`, not a check in this method: two callers can
   * both find no existing grant and both try to write, and the database refuses the second.
   *
   * **The key deliberately excludes the tier.** Including it — as this design originally did —
   * means a reader who upgrades mid-period is granted a second time, because the new tier makes a
   * new key. A test caught it granting 1 + 3 = 4 for one month, which is a patron upgrading and
   * downgrading to mint tokens. One grant per reader per period, whatever they do to their
   * membership in between; the tier they hold when the period is first granted is the tier that
   * period pays.
   */
  async grantDue(creatorId: string, userId: string, at: Date = new Date()): Promise<void> {
    const policy = await this.prisma.creatorPolicy.findUnique({
      where: { creatorId },
      select: { redeemTokensEnabled: true },
    });
    // A board that has not opted in grants nothing, whatever its tiers say.
    if (!policy?.redeemTokensEnabled) return;

    const membership = await this.prisma.membership.findUnique({
      where: { userId_creatorId: { userId, creatorId } },
      select: {
        isActivePatron: true,
        currentTierId: true,
        currentTier: { select: { tokensPerPeriod: true } },
      },
    });
    if (!membership?.isActivePatron || !membership.currentTierId) return;

    const amount = membership.currentTier?.tokensPerPeriod ?? 0;
    // Zero is where every tier starts, so enabling the feature grants nothing by itself. Writing
    // a zero-token grant row would also make the ledger a list of non-events.
    if (amount <= 0) return;

    const periodKey = periodKeyFor(at);
    const tierId = membership.currentTierId;

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.tokenLedger.create({
          data: { creatorId, userId, kind: 'TIER_GRANT', amount, tierId, periodKey },
        });
        await tx.tokenBalance.upsert({
          where: { creatorId_userId: { creatorId, userId } },
          create: { creatorId, userId, available: amount },
          update: { available: { increment: amount } },
        });
      });
    } catch (error) {
      // P2002 is the unique constraint doing its job: somebody else granted this period first,
      // and the balance they wrote is the one that stands. Anything else is a real failure.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return;
      }
      throw error;
    }
  }
}
