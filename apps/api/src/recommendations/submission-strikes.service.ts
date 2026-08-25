import { Injectable, Logger } from '@nestjs/common';
import { StrikeReason } from '@prisma/client';
import { AbuseService } from '../abuse/abuse.service';
import { RateLimitService } from '../limits/rate-limit.service';

/**
 * How many de-duplicated resubmissions in an hour earn a strike. A refunded duplicate is free to
 * the limiter but not to us: it already spent a moderation pass and a catalogue call before the
 * de-dupe check saw it, so replaying one was unlimited and free.
 */
export const DUPLICATE_STRIKE_THRESHOLD = 5;

/**
 * How many 429s in an hour earn a strike. Design §6.4 says strikes come from *repeated*
 * rate-limit hits, and the submission cap is one an hour: a patron with a second idea ten
 * minutes later is not an abuser, and striking their first 429 timed them out of every board
 * they pay for after three impatient clicks.
 */
export const RATE_LIMIT_STRIKE_THRESHOLD = 5;

/**
 * What a refused submission costs its sender.
 *
 * Its own service because every method here is a side effect of a decision already made
 * elsewhere: none of them may change the caller's answer, and one of them exists purely to give
 * back a quota token that a later refusal made unfair to keep. Read together they are a policy;
 * scattered through the submission flow they read as bookkeeping and get "tidied".
 */
@Injectable()
export class SubmissionStrikesService {
  private readonly logger = new Logger(SubmissionStrikesService.name);

  constructor(
    private readonly abuse: AbuseService,
    private readonly limits: RateLimitService,
  ) {}

  /**
   * A strike is a side effect of a decision already made. It must never turn a 400 into a 500 —
   * the caller's answer does not depend on whether we managed to write it down.
   */
  async recordStrike(userId: string, reason: StrikeReason): Promise<void> {
    try {
      await this.abuse.strike(userId, reason);
    } catch (error) {
      this.logger.warn(`Could not record a strike for user ${userId}: ${String(error)}`);
    }
  }

  /**
   * Counted rather than limited: the first few duplicates are exactly what design §5 wants.
   *
   * Keyed per creator, because a patron suggesting one popular title to each of six boards they
   * follow produces six duplicates in a session — every one of them a 200 and the behaviour §5
   * asks for. Only replaying at *one* board is the flood this guards against.
   */
  countDuplicate(userId: string, creatorId: string): Promise<void> {
    return this.countTowardStrike(
      `duplicate:${userId}:${creatorId}`,
      DUPLICATE_STRIKE_THRESHOLD,
      'DUPLICATE_FLOOD',
      userId,
    );
  }

  /**
   * Strikes exactly once, on the request that crosses the threshold. `>=` struck on every
   * request past it, so six duplicates — a cheap, sanctioned path — earned two strikes and an
   * hour's lockout.
   */
  async countTowardStrike(
    key: string,
    threshold: number,
    reason: StrikeReason,
    userId: string,
  ): Promise<void> {
    try {
      const seen = await this.limits.count(key, 3600);
      if (seen === threshold) await this.abuse.strike(userId, reason);
    } catch (error) {
      this.logger.warn(`Could not count ${reason} for user ${userId}: ${String(error)}`);
    }
  }

  async refund(...keys: string[]): Promise<void> {
    await Promise.all(keys.map((key) => this.limits.refund(key)));
  }
}
