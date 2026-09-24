import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
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

  /**
   * Spends one token on an accepted entry.
   *
   * **A conditional decrement, never a read-then-write.** Two requests that both read a balance
   * of one would both pass a check and both write zero, and the reader would have spent a token
   * they did not have. `updateMany ... where available > 0` lets the database answer instead: a
   * count of zero means the balance was empty and the spend is refused. This is the same shape
   * `ModerationActionsService.changeStatus` uses, for the same reason.
   *
   * Everything else — the ledger row, the redeem, the entry's counter — happens in one
   * transaction with it. A decrement whose redeem never landed is a token that vanished.
   */
  async spend(
    creatorId: string,
    userId: string,
    recommendationId: string,
    note: string,
  ): Promise<{ id: string }> {
    const trimmed = note.trim();
    // The note is the whole instruction — it is what the creator reads to know what to play, and
    // nothing else in the system says it. An empty one makes the redeem unactionable.
    if (trimmed.length === 0) throw new BadRequestException('A redeem needs a note');
    if (trimmed.length > 200) throw new BadRequestException('That note is too long');

    const policy = await this.prisma.creatorPolicy.findUnique({
      where: { creatorId },
      select: { redeemTokensEnabled: true },
    });
    if (!policy?.redeemTokensEnabled) throw new NotFoundException();

    // Scoped by creatorId: an id alone says nothing about which board owns it, and a token on one
    // board must never be spendable on another. 404 rather than 403, as everywhere else — a
    // reader may not learn an entry exists by being refused it.
    const entry = await this.prisma.recommendation.findFirst({
      where: { id: recommendationId, creatorId },
      select: { id: true, status: true },
    });
    if (!entry) throw new NotFoundException();
    // Only an accepted entry. A redeem on something still in the queue would let money skip
    // moderation, which is the one thing the queue exists to prevent.
    if (entry.status !== 'ACCEPTED') {
      throw new ConflictException('Only an accepted entry can be redeemed');
    }

    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.tokenBalance.updateMany({
        where: { creatorId, userId, available: { gt: 0 } },
        data: { available: { decrement: 1 } },
      });
      // Zero rows means the balance was zero — or there is no balance row at all, which is the
      // same answer to the reader.
      if (count === 0) throw new ConflictException('No tokens left to spend');

      const redeem = await tx.redeem.create({
        data: { creatorId, recommendationId, userId, note: trimmed },
        select: { id: true },
      });
      await tx.tokenLedger.create({
        data: { creatorId, userId, kind: 'SPEND', amount: -1, redeemId: redeem.id },
      });
      await tx.recommendation.update({
        where: { id: recommendationId },
        data: { unconsumedRedeems: { increment: 1 } },
      });
      return redeem;
    });
  }
}
