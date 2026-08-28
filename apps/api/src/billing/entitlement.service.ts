import { Injectable } from '@nestjs/common';
import { SubscriptionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * How long entitlement survives a failed payment.
 *
 * A card that expired on Tuesday is not a reader who stopped paying, and the provider will retry
 * for days. Taking the palette away mid-retry is a worse experience than the retry succeeding.
 * Long enough to cover a normal dunning cycle, short enough that it is not a free month.
 */
export const GRACE_PERIOD_MS = 5 * 24 * 60 * 60 * 1000;

export interface SubscriptionState {
  status: SubscriptionStatus;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
}

/**
 * Turns a subscription into the one thing the rest of the application asks about.
 *
 * `User.premiumUntil` is a projection of the subscription, not a second source of truth. Five
 * gates read that column — notification preferences, carry-over, board settings, the reaction
 * palette, the session guard — and pointing each of them at the subscription table instead would
 * be five call sites and five chances to answer differently.
 *
 * No network and no provider vocabulary: everything here is a decision about what a state means,
 * which is the part worth being able to read on its own.
 */
@Injectable()
export class EntitlementService {
  constructor(private readonly prisma: PrismaService) {}

  async applyTo(userId: string, state: SubscriptionState): Promise<Date | null> {
    const earned = entitledUntil(state);

    const current = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { premiumUntil: true },
    });

    const premiumUntil = keepsLonger(state) ? later(current.premiumUntil, earned) : earned;
    await this.prisma.user.update({ where: { id: userId }, data: { premiumUntil } });
    return premiumUntil;
  }
}

/**
 * What this state entitles them to, as a date.
 *
 * `CANCELLED` runs to the period end on purpose: cancelling stops the renewal, it does not take
 * back the month already paid for.
 */
function entitledUntil(state: SubscriptionState): Date | null {
  switch (state.status) {
    case 'ACTIVE':
    case 'CANCELLED':
      return state.currentPeriodEnd;
    case 'PAST_DUE':
      return new Date(state.currentPeriodEnd.getTime() + GRACE_PERIOD_MS);
    case 'REFUNDED':
    case 'EXPIRED':
      // The money went back, or the subscription is over and its period with it. No grace: a
      // grace window on a refund is a window for buying premium and taking it back.
      return null;
  }
}

/**
 * Whether a stale event may be allowed to shorten entitlement.
 *
 * Providers do not promise ordering, so a renewal and the event before it can arrive the wrong
 * way round. Taking the later of the two dates means a stale event cannot revoke a renewal that
 * already landed — except when the money went back, which is the one case where going backwards
 * is exactly right.
 */
function keepsLonger(state: SubscriptionState): boolean {
  return state.status !== 'REFUNDED';
}

function later(a: Date | null, b: Date | null): Date | null {
  if (a === null) return b;
  if (b === null) return a;
  return a > b ? a : b;
}
