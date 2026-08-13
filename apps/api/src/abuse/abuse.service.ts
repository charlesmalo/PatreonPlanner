import { Injectable, Logger } from '@nestjs/common';
import { StrikeReason } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DECAY_AFTER_MS, penaltyFor } from './penalty';

/** Bounded so one tick cannot rewrite the whole table. */
export const DECAY_BATCH_SIZE = 100;

@Injectable()
export class AbuseService {
  private readonly logger = new Logger(AbuseService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Design §6.4's escalating penalty. The count is incremented atomically and the new timeout is
   * computed from the *returned* value, so two concurrent strikes cannot both read the same
   * starting count — a lost update there would be a discount for hitting harder.
   */
  async strike(userId: string, reason: StrikeReason): Promise<void> {
    // One transaction with a row lock, not an increment followed by a separate update. Read and
    // write split across two statements let two concurrent strikes compute from the same stale
    // snapshot and the later commit win — so hitting twice at once bought a *shorter* penalty
    // than hitting twice in sequence, which is a discount for hitting harder.
    await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      // Ensures the row exists without disturbing an existing one, so the lock below always has
      // something to take.
      await tx.$executeRaw`
        INSERT INTO "AbuseRecord" ("id", "userId", "strikeCount", "createdAt", "updatedAt")
        VALUES (gen_random_uuid(), ${userId}::uuid, 0, ${now}, ${now})
        ON CONFLICT ("userId") DO NOTHING
      `;
      const [locked] = await tx.$queryRaw<
        Array<{ strikeCount: number; timeoutUntil: Date | null }>
      >`
        SELECT "strikeCount", "timeoutUntil" FROM "AbuseRecord"
        WHERE "userId" = ${userId}::uuid
        FOR UPDATE
      `;
      // The row was deleted between the insert and the lock — a decay pass, or the account went.
      if (!locked) return;

      const strikeCount = locked.strikeCount + 1;
      const penalty = penaltyFor(strikeCount);
      const earned = penalty > 0 ? new Date(now.getTime() + penalty) : null;
      // Never shorten a running timeout: after a decay lowers the count, the next strike's
      // penalty can be smaller than the time remaining, and that would reward reoffending.
      const timeoutUntil =
        locked.timeoutUntil && (!earned || locked.timeoutUntil > earned)
          ? locked.timeoutUntil
          : earned;

      await tx.abuseRecord.update({
        where: { userId },
        data: { strikeCount, lastStrikeAt: now, lastReason: reason, timeoutUntil },
      });
    });
  }

  /** When the user may submit again, or null when they may now. Creates nothing. */
  async timeoutFor(userId: string): Promise<Date | null> {
    const record = await this.prisma.abuseRecord.findUnique({
      where: { userId },
      select: { timeoutUntil: true },
    });
    if (!record?.timeoutUntil) return null;
    return record.timeoutUntil > new Date() ? record.timeoutUntil : null;
  }

  /**
   * Design §6.4: the score "decays with good behaviour". One strike per quiet period, not all of
   * them — a user with twenty strikes has earned twenty periods of patience.
   *
   * Decays the *count*, never the timeout: forgiving the timeout instead would let someone sit
   * out a penalty and return at full severity. Returns how many records were decayed.
   */
  async decayOnce(): Promise<number> {
    const cutoff = new Date(Date.now() - DECAY_AFTER_MS);
    const now = new Date();

    const quiet = await this.prisma.abuseRecord.findMany({
      where: {
        lastStrikeAt: { lt: cutoff },
        // Sitting out a penalty must not also earn forgiveness for it.
        OR: [{ timeoutUntil: null }, { timeoutUntil: { lt: now } }],
      },
      orderBy: { lastStrikeAt: 'asc' },
      select: { id: true, userId: true, strikeCount: true },
      take: DECAY_BATCH_SIZE,
    });

    let decayed = 0;
    for (const row of quiet) {
      try {
        if (row.strikeCount <= 1) {
          // Nothing left to forgive. Keeping the row would accumulate one per user who ever
          // slipped once.
          await this.prisma.abuseRecord.delete({ where: { id: row.id } });
        } else {
          await this.prisma.abuseRecord.update({
            where: { id: row.id },
            data: {
              strikeCount: { decrement: 1 },
              // Restarts the clock, so the next strike takes another quiet period rather than
              // the whole record clearing on the following tick.
              lastStrikeAt: now,
            },
          });
        }
        decayed += 1;
      } catch (error) {
        // A record deleted concurrently — the user's account went — is not worth ending the tick.
        this.logger.warn(`Decay failed for record ${row.id}: ${(error as Error).message}`);
      }
    }
    return decayed;
  }
}
