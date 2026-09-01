import { Injectable, Logger } from '@nestjs/common';
import { SubscriptionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EntitlementService } from './entitlement.service';
import { ReceiptService } from './receipt.service';
import type { SubscriptionEvent } from './payment-provider';

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlement: EntitlementService,
    private readonly receipts: ReceiptService,
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

    // Whether the transaction below actually changed the subscription. A delivery can be recorded
    // as handled while changing nothing — see the superseded case — and the entitlement recompute
    // afterwards must not run for one of those.
    let changed = false;
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.processedWebhookEvent.create({
          data: { id: idempotencyKey, provider, eventType: event.eventType },
        });

        // Keyed on the reader, not on the provider's subscription id, because the reader is what
        // this table holds one of. `userId` is unique here by design — two rows would make "are
        // they premium" a question with two answers.
        //
        // Keying on `providerSubscriptionId` instead had a silent failure with real money behind
        // it: somebody whose subscription ended and who then subscribed again is issued a *new*
        // id by the provider, so the upsert found nothing, tried to create, collided on the unique
        // `userId`, raised P2002 — and P2002 is caught below and read as "already handled". They
        // paid, nothing was recorded, nothing was granted, and the provider was told 200.
        const existing = await tx.subscription.findUnique({
          where: { userId: event.userId },
          select: { providerSubscriptionId: true, status: true, currentPeriodEnd: true },
        });

        if (existing && !replaces(existing, event)) {
          // An event from a subscription they have already left behind — a final cancellation, or
          // a retry that crossed the gap. Writing it would take premium from somebody who has just
          // paid again. Recorded as seen so the provider stops retrying, and nothing else.
          this.logger.warn(
            `Ignoring ${event.eventType} for superseded subscription ${event.providerSubscriptionId}; ` +
              `${existing.providerSubscriptionId} is the current one`,
          );
          return;
        }

        await tx.subscription.upsert({
          where: { userId: event.userId },
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
            // Carried on the update too, so a resubscribe repoints the row at the subscription
            // that is actually live rather than leaving it naming a dead one.
            provider,
            providerSubscriptionId: event.providerSubscriptionId,
            providerCustomerId: event.providerCustomerId,
            status: event.status,
            currentPeriodEnd: event.currentPeriodEnd,
            cancelAtPeriodEnd: event.cancelAtPeriodEnd,
            // Backfilled on any later event for a subscription created before this was stored,
            // which is how those rows become refundable without a migration that invents data.
            ...(event.providerOrderId ? { providerOrderId: event.providerOrderId } : {}),
          },
        });
        // In the same transaction as the subscription write. A receipt for a change that was
        // rolled back is a charge in somebody's history that never happened.
        //
        // Only when the event actually carried one: a cancellation and a reconciliation read move
        // a subscription without taking money, and minting a receipt for either would invent a
        // payment.
        if (event.payment) {
          await this.receipts.record(
            tx,
            provider,
            event.userId,
            event.providerOrderId,
            event.payment,
          );
        }
        changed = true;
      });
    } catch (error) {
      // Two deliveries of the same event racing each other: one inserted the record, the other
      // lost the unique constraint. The winner did the work, so this is success rather than
      // failure — and answering 5xx would have the provider retry an event already applied.
      if (isUniqueViolation(error)) return false;
      throw error;
    }

    // Nothing was written, so there is nothing to recompute from — and recomputing against this
    // event would apply the superseded subscription's dates.
    if (!changed) return false;

    // Outside the transaction on purpose: the projection is derived, so recomputing it is always
    // safe, and holding the subscription write open across it buys nothing.
    await this.entitlement.applyTo(event.userId, event);
    return true;
  }
}

/**
 * Whether an event about one subscription should overwrite the row currently held for that reader.
 *
 * Always yes when it is the same subscription. When it is a different one, the reader has
 * resubscribed — which is ordinary — and the question is which of the two is current:
 *
 * - the stored one has already ended, so anything new supersedes it; or
 * - the incoming one runs longer, which a genuine resubscribe does and a stale retry does not.
 *
 * Anything else is an event from a subscription that has been left behind.
 */
function replaces(
  existing: { providerSubscriptionId: string; status: SubscriptionStatus; currentPeriodEnd: Date },
  event: SubscriptionEvent,
): boolean {
  if (existing.providerSubscriptionId === event.providerSubscriptionId) return true;
  if (ENDED.includes(existing.status)) return true;
  return event.currentPeriodEnd > existing.currentPeriodEnd;
}

/** Statuses that mean the stored subscription is over, so a new one cannot be a stale retry. */
const ENDED: SubscriptionStatus[] = ['CANCELLED', 'EXPIRED', 'REFUNDED'];

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string })?.code === 'P2002';
}
