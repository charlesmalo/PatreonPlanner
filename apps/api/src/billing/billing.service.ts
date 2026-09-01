import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EntitlementService } from './entitlement.service';
import type { SubscriptionEvent } from './payment-provider';

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlement: EntitlementService,
  ) {}

  /**
   * What this reader is paying for, or null.
   *
   * Deliberately narrow: a status, when the period ends, and whether it will renew. Nothing here
   * comes from the provider's customer record, because none of that is ours to hold.
   */
  forUser(userId: string) {
    return this.prisma.subscription.findUnique({
      where: { userId },
      select: { status: true, currentPeriodEnd: true, cancelAtPeriodEnd: true },
    });
  }

  /**
   * A refunded order: find what it paid for and take the entitlement back.
   *
   * Matched on the order id because that is all a refund names — the order payload carries no
   * subscription id. A subscription written before the order id was stored cannot be matched, and
   * is left to reconciliation when its period runs out.
   *
   * No match is not a failure: most refunded orders in a store that sells more than one thing are
   * nothing to do with a subscription.
   */
  async applyRefund(
    provider: string,
    idempotencyKey: string,
    event: { eventType: string; providerOrderId: string },
  ): Promise<boolean> {
    const subscription = await this.prisma.subscription.findFirst({
      where: { providerOrderId: event.providerOrderId },
      select: { id: true, userId: true, currentPeriodEnd: true, cancelAtPeriodEnd: true },
    });
    if (!subscription) return false;

    const seen = await this.prisma.processedWebhookEvent.findUnique({
      where: { id: idempotencyKey },
      select: { id: true },
    });
    if (seen) return false;

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.processedWebhookEvent.create({
          data: { id: idempotencyKey, provider, eventType: event.eventType },
        });
        await tx.subscription.update({
          where: { id: subscription.id },
          data: { status: 'REFUNDED' },
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) return false;
      throw error;
    }

    // The rule this makes reachable at last: a refund revokes immediately and gets no grace,
    // because a grace window on a refund is a window for buying premium and taking it back.
    await this.entitlement.applyTo(subscription.userId, {
      status: 'REFUNDED',
      currentPeriodEnd: subscription.currentPeriodEnd,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    });
    return true;
  }

  /**
   * Records a delivery and applies it, or does nothing because we have seen it before.
   *
   * The record and the effect share one transaction. Recording first and applying after would
   * lose an event to a crash in between; applying first and recording after would apply it twice
   * for the same crash. One transaction has neither failure — the retry finds nothing recorded
   * and does the whole thing again.
   *
   * Returns whether it was new, which is only for logging: the endpoint answers 2xx either way,
   * because a retry that is correctly ignored is a success from the provider's point of view.
   */
  async applyEvent(
    provider: string,
    idempotencyKey: string,
    event: SubscriptionEvent,
  ): Promise<boolean> {
    // The primary key on ProcessedWebhookEvent is what actually guarantees exactly-once — this
    // read only avoids raising an expected exception on the common retry path, and removing it
    // changes nothing but the noise. Verified: with both this and the catch below removed, a
    // redelivery throws and the test notices.
    // A user id that names nobody. Retrying cannot fix it — the account will not appear — so a
    // 5xx here would have the provider retry this event for as long as it keeps them, forever.
    // Recorded as handled and dropped instead, with a warning, because the alternative is a
    // retry loop that outlives whoever caused it.
    const exists = await this.prisma.user.findUnique({
      where: { id: event.userId },
      select: { id: true },
    });
    if (!exists) {
      this.logger.warn(
        `Webhook ${event.eventType} named a user that does not exist; ignoring the delivery`,
      );
      return false;
    }

    const seen = await this.prisma.processedWebhookEvent.findUnique({
      where: { id: idempotencyKey },
      select: { id: true },
    });
    if (seen) return false;

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.processedWebhookEvent.create({
          data: { id: idempotencyKey, provider, eventType: event.eventType },
        });
        await tx.subscription.upsert({
          where: { providerSubscriptionId: event.providerSubscriptionId },
          create: {
            userId: event.userId,
            provider,
            providerSubscriptionId: event.providerSubscriptionId,
            providerCustomerId: event.providerCustomerId,
            providerOrderId: event.providerOrderId,
            status: event.status,
            currentPeriodEnd: event.currentPeriodEnd,
            cancelAtPeriodEnd: event.cancelAtPeriodEnd,
          },
          update: {
            status: event.status,
            currentPeriodEnd: event.currentPeriodEnd,
            cancelAtPeriodEnd: event.cancelAtPeriodEnd,
            // Backfilled on any later event for a subscription created before this was stored,
            // which is how those rows become refundable without a migration that invents data.
            ...(event.providerOrderId ? { providerOrderId: event.providerOrderId } : {}),
          },
        });
      });
    } catch (error) {
      // Two deliveries of the same event racing each other: one inserted the record, the other
      // lost the unique constraint. The winner did the work, so this is success rather than
      // failure — and answering 5xx would have the provider retry an event already applied.
      if (isUniqueViolation(error)) return false;
      throw error;
    }

    // Outside the transaction on purpose: the projection is derived, so recomputing it is always
    // safe, and holding the subscription write open across it buys nothing.
    await this.entitlement.applyTo(event.userId, event);
    return true;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string })?.code === 'P2002';
}
