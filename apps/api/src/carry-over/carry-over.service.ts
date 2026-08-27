import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { can, type Viewer } from '../access/capability';
import { CreatorsService } from '../creators/creators.service';
import { PrismaService } from '../prisma/prisma.service';
import { SubmissionsService } from '../recommendations/submissions.service';
import type { SubmitRecommendationDto } from '../recommendations/dto/submit-recommendation.dto';

/**
 * Putting one reader's list in front of every board they support.
 *
 * The whole feature is a queue of deliveries and the order in which one of them is decided. It
 * deliberately owns no submission logic of its own: every delivery goes through the endpoint
 * patrons already use, which gets moderation-then-limit-then-de-dupe ordering, eligibility at
 * delivery time, and the disclosure properties right. A second path would have to re-derive all
 * of that, and would be wrong in a way nothing would notice.
 */
@Injectable()
export class CarryOverService {
  private readonly logger = new Logger(CarryOverService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly creators: CreatorsService,
    private readonly submissions: SubmissionsService,
  ) {}

  /**
   * Queues one reader's entries at the boards they chose.
   *
   * Scoped to entries they submitted themselves: carrying somebody else's suggestion is not a
   * list, it is a way to put another person's words on a board under your own name.
   *
   * Idempotent — re-broadcasting the same list adds nothing, because the delivery row is also
   * where the outcome is reported back and a second copy would report it twice.
   */
  async enqueue(userId: string, sourceIds: string[], creatorIds: string[]): Promise<number> {
    if (sourceIds.length === 0 || creatorIds.length === 0) return 0;

    const own = await this.prisma.recommendation.findMany({
      where: { id: { in: sourceIds }, submittedByUserId: userId },
      select: { id: true },
    });
    if (own.length === 0) return 0;

    const { count } = await this.prisma.carryOverDelivery.createMany({
      data: own.flatMap((source) =>
        creatorIds.map((creatorId) => ({
          userId,
          creatorId,
          sourceRecommendationId: source.id,
        })),
      ),
      skipDuplicates: true,
    });
    return count;
  }

  /**
   * Decides one delivery. The order below *is* the design:
   *
   * 1. the creator switched carry-over off — their board, their answer, asked first so nothing
   *    else runs on a board that did not want this;
   * 2. this board refused the title before — de-duplication ignores `REJECTED` so a person can
   *    resubmit after fixing what was wrong, which is judgement a queue does not have;
   * 3. submit it, which decides eligibility, moderation, rate limiting and de-duplication;
   * 4. and if the board's own limit is reached, wait — the limit is the creator's, and burning
   *    the delivery on a 429 would make the feature quietly lossy.
   */
  async deliver(deliveryId: string): Promise<void> {
    const delivery = await this.prisma.carryOverDelivery.findUnique({
      where: { id: deliveryId },
      select: {
        id: true,
        userId: true,
        creatorId: true,
        outcome: true,
        source: {
          select: { type: true, customTitle: true, description: true, title: true },
        },
        creator: { select: { policy: { select: { acceptsCarryOver: true } } } },
      },
    });
    // Already decided, or the row is gone. Either way there is nothing to do, and re-running it
    // would submit the same title a second time.
    if (!delivery || delivery.outcome !== 'PENDING') return;

    if (delivery.creator.policy?.acceptsCarryOver === false) {
      await this.settle(delivery.id, 'NOT_ACCEPTED');
      return;
    }

    // Resolved here, explicitly, and not inherited from `submit`.
    //
    // `SubmissionsService.submit` does *not* check the SUBMIT capability — the guard on the
    // controller does, and a queue calling the service directly walks straight past it. A test
    // caught this delivering to a board whose tier gate the reader did not meet. Checked at
    // delivery rather than at enqueue, because a pledge can lapse in between and a queue must
    // not outlive the entitlement that authorised it.
    if (!(await this.maySubmit(delivery.userId, delivery.creatorId))) {
      await this.settle(delivery.id, 'NOT_ELIGIBLE');
      return;
    }

    const refusedBefore = await this.prisma.recommendation.findFirst({
      where: {
        creatorId: delivery.creatorId,
        status: 'REJECTED',
        ...(delivery.source.title
          ? { titleId: delivery.source.title.id }
          : { normalizedTitle: normalize(delivery.source.customTitle ?? '') }),
      },
      select: { id: true },
    });
    if (refusedBefore) {
      await this.settle(delivery.id, 'REFUSED_BEFORE', refusedBefore.id);
      return;
    }

    try {
      const result = await this.submissions.submit(
        delivery.creatorId,
        delivery.userId,
        dtoFor(delivery.source),
        false,
        { viaCarryOver: true },
      );
      await this.settle(
        delivery.id,
        result.duplicate ? 'ALREADY_PRESENT' : 'SUBMITTED',
        result.recommendation.id,
      );
    } catch (error) {
      // The board's own limit. Left PENDING so the next tick tries again, which is what "the
      // queue waits at each board's rate" actually means.
      if (error instanceof HttpException && error.getStatus() === HttpStatus.TOO_MANY_REQUESTS) {
        return;
      }
      this.logger.warn(`Carry-over delivery ${delivery.id} failed: ${String(error)}`);
      await this.settle(delivery.id, 'FAILED', null, messageOf(error));
    }
  }

  /** The same pure resolver the guard uses — never a second implementation of "may they post". */
  private async maySubmit(userId: string, creatorId: string): Promise<boolean> {
    const [policy, membership, staff] = await Promise.all([
      this.creators.policyForResolver(creatorId),
      this.prisma.membership.findUnique({
        where: { userId_creatorId: { userId, creatorId } },
        select: { amountCents: true, isActivePatron: true },
      }),
      this.prisma.creatorStaff.findUnique({
        where: { creatorId_userId: { creatorId, userId } },
        select: { role: true, permissions: true },
      }),
    ]);
    const viewer: Viewer = {
      userId,
      isAuthenticated: true,
      isActivePatron: membership?.isActivePatron ?? false,
      // Null rather than 0 when they do not pledge: 0 would satisfy a gate set at 0.
      pledgeAmountCents: membership?.isActivePatron ? (membership.amountCents ?? null) : null,
      staffRole: staff?.role ?? null,
      permissions: [],
    };
    return can('SUBMIT', viewer, policy);
  }

  private settle(
    id: string,
    outcome: Prisma.CarryOverDeliveryUpdateInput['outcome'],
    resultRecommendationId: string | null = null,
    detail?: string,
  ) {
    return this.prisma.carryOverDelivery.update({
      where: { id },
      data: { outcome, resultRecommendationId, detail: detail ?? null, processedAt: new Date() },
    });
  }
}

/** The same normalisation the de-dupe index uses, so "refused before" means what de-dupe means. */
function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function dtoFor(source: {
  type: string;
  customTitle: string | null;
  description: string | null;
  title: { tmdbId: number } | null;
}): SubmitRecommendationDto {
  return {
    type: source.type,
    ...(source.title ? { tmdbId: source.title.tmdbId } : { customTitle: source.customTitle ?? '' }),
    description: source.description ?? undefined,
  } as SubmitRecommendationDto;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : 'unknown';
}
