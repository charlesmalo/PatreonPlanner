import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EntitlementService } from './entitlement.service';
import { LemonSqueezyAdapter } from './lemon-squeezy.adapter';

/** Small: each one is a request to the provider, and the tick is shared with six other jobs. */
export const RECONCILE_BATCH = 20;

/**
 * Catches up with subscriptions whose renewal never reached us.
 *
 * Most lost webhooks fail safe by themselves, because entitlement is a date: a missed
 * cancellation still expires at the period end. The case that does not is a renewal we never
 * heard about — the reader paid and quietly lost premium — and that is the only case this exists
 * for. It is also why an error here must never revoke: "the provider did not answer" and "the
 * subscription ended" are different facts, and treating the first as the second takes premium
 * away from somebody who is paying for it.
 */
@Injectable()
export class BillingReconcileJob {
  private readonly logger = new Logger(BillingReconcileJob.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly adapter: LemonSqueezyAdapter,
    private readonly entitlement: EntitlementService,
  ) {}

  async runOnce(): Promise<number> {
    // Past its period end but still believed active: a renewal was due and did not arrive.
    // A CANCELLED one reaching its end is not a mystery — it ended, exactly as it said it would.
    const stale = await this.prisma.subscription.findMany({
      where: { status: { in: ['ACTIVE', 'PAST_DUE'] }, currentPeriodEnd: { lt: new Date() } },
      orderBy: { currentPeriodEnd: 'asc' },
      select: { userId: true, providerSubscriptionId: true },
      take: RECONCILE_BATCH,
    });

    let reconciled = 0;
    for (const subscription of stale) {
      try {
        const fresh = await this.adapter.fetchSubscription(subscription.providerSubscriptionId);
        // Null means the provider did not answer, or answered something we do not understand.
        // Leaving it alone is the whole point: the next tick asks again, and in the meantime a
        // paying reader keeps what they paid for.
        if (!fresh) continue;

        await this.prisma.subscription.update({
          where: { providerSubscriptionId: subscription.providerSubscriptionId },
          data: {
            status: fresh.status,
            currentPeriodEnd: fresh.currentPeriodEnd,
            cancelAtPeriodEnd: fresh.cancelAtPeriodEnd,
          },
        });
        await this.entitlement.applyTo(subscription.userId, fresh);
        reconciled += 1;
      } catch (error) {
        // One unreachable subscription must not strand the rest of the batch behind it.
        this.logger.warn(
          `Reconciling ${subscription.providerSubscriptionId} failed: ${String(error)}`,
        );
      }
    }
    return reconciled;
  }
}
