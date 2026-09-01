import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '../config/config.module';
import { SubscriptionStatus } from '@prisma/client';
import type { PaymentProvider, RefundEvent, SubscriptionEvent } from './payment-provider';

/**
 * The only file that knows this provider is Lemon Squeezy.
 *
 * Everything else in `billing/` speaks in subscriptions and entitlement, through
 * `PaymentProvider`. Moving to Paddle should be a sibling of this file and a config value, not a
 * search across the codebase.
 */

/**
 * Their vocabulary to ours.
 *
 * Anything unrecognised is deliberately absent rather than defaulted: a status we have never seen
 * must not quietly become ACTIVE, and a provider adding one should make us refuse the event
 * loudly rather than grant a month for free.
 */
const STATUS: Record<string, SubscriptionStatus> = {
  active: 'ACTIVE',
  on_trial: 'ACTIVE',
  // "Payment collection has been paused and the subscription is still active" — so access
  // continues. Absent from the first version of this map, which meant a pause was ignored
  // entirely rather than handled.
  paused: 'ACTIVE',
  past_due: 'PAST_DUE',
  // All renewal retries have failed. Still PAST_DUE rather than EXPIRED: the grace window is
  // what decides when access actually stops, and it is measured from the period end either way.
  unpaid: 'PAST_DUE',
  cancelled: 'CANCELLED',
  expired: 'EXPIRED',
  // Not a status Lemon Squeezy puts on a subscription — refunds are an *order* event there. Kept
  // because the entitlement rule for it is real and correct, and because a provider that ever
  // does send it should be handled rather than ignored. See the note on refunds below.
  refunded: 'REFUNDED',
};

/** Cancelled and expired subscriptions carry their end date in `ends_at`; everything else renews. */
const ENDED: SubscriptionStatus[] = ['CANCELLED', 'EXPIRED'];

@Injectable()
export class LemonSqueezyAdapter implements PaymentProvider {
  readonly provider = 'lemonsqueezy';

  constructor(private readonly config: ConfigService) {}

  /**
   * Where to send somebody who wants to subscribe.
   *
   * Their user id rides along as the provider's custom data, which is what the webhook reads back
   * — never an email address. Matching a payment to an account by email is how one person's money
   * ends up entitling somebody else's account.
   *
   * Built by mutating the configured URL rather than composing a new one, so a store URL that
   * already carries a query string keeps it. Rebuilding would drop a `?discount=` and charge the
   * reader a different price than the link promised.
   */
  checkoutUrlFor(userId: string): string | null {
    const base = this.config.get('LEMONSQUEEZY_CHECKOUT_URL');
    if (!base) return null;

    const url = new URL(base);
    url.searchParams.set('checkout[custom][user_id]', userId);
    return url.toString();
  }

  /** Undefined means this instance cannot verify a delivery, and so must refuse every one. */
  signingSecret(): string | undefined {
    return this.config.get('LEMONSQUEEZY_WEBHOOK_SECRET');
  }

  /**
   * Asks the provider what a subscription is actually doing.
   *
   * The only network call in `billing/`, and the only reason reconciliation exists: webhooks get
   * lost to a deploy mid-delivery, a timeout, or a bug in our own handler. Returns null when it
   * cannot answer — which the caller must treat as "unknown", never as "cancelled".
   */
  async fetchSubscription(providerSubscriptionId: string): Promise<SubscriptionEvent | null> {
    const key = this.config.get('LEMONSQUEEZY_API_KEY');
    if (!key) return null;

    const url = `${this.config.get('LEMONSQUEEZY_API_BASE_URL')}/v1/subscriptions/${encodeURIComponent(providerSubscriptionId)}`;
    const response = await fetch(url, {
      headers: {
        // Both content headers, as their docs specify. JSON:API servers are entitled to refuse a
        // request that does not ask for the media type by name.
        Accept: 'application/vnd.api+json',
        'Content-Type': 'application/vnd.api+json',
        Authorization: `Bearer ${key}`,
      },
    });
    if (!response.ok) return null;

    // Reusing `parse` so the reconciled shape and the webhook shape cannot drift apart. The
    // meta block a webhook carries is not on a direct read, so the caller's own id fills it in.
    //
    // It also decides what is *not* taken. A retrieved subscription carries `user_email`,
    // `user_name`, `card_brand` and `card_last_four`; `parse` reads none of them, which is what
    // keeps the promise that this application holds no billing PII. Passing the response
    // through anything that copies attributes wholesale would break that silently.
    const body = (await response.json()) as { data?: unknown };
    return this.parse({ meta: { event_name: 'subscription_reconciled' }, data: body.data });
  }

  /**
   * HMAC-SHA256 over the exact bytes that arrived.
   *
   * The raw body, never the parsed one: `JSON.parse` then `JSON.stringify` reorders nothing in
   * practice but is not guaranteed to reproduce the same bytes, and a handler that verifies a
   * re-serialised body verifies nothing at all. `main.ts` keeps `rawBody` for this reason.
   */
  verify(rawBody: Buffer, signature: string | undefined, secret: string): boolean {
    if (!signature) return false;
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    const provided = Buffer.from(signature, 'utf8');
    const computed = Buffer.from(expected, 'utf8');
    // Compared for length first: timingSafeEqual throws on a mismatch, and a throw here would be
    // a 500 — which the provider retries — rather than the rejection it should be.
    return provided.length === computed.length && timingSafeEqual(provided, computed);
  }

  /**
   * A stable key for "have we already handled this delivery".
   *
   * The digest of the body rather than an event id from the provider: a retry is the same bytes
   * by definition, so this works whoever the provider is and however they identify an event.
   *
   * The cost is that two *genuinely distinct* events with byte-identical payloads would collapse
   * into one. Every event here carries a subscription id and a period end, so identical bytes
   * means a redelivery rather than a coincidence.
   */
  idempotencyKey(rawBody: Buffer): string {
    return createHash('sha256').update(rawBody).digest('hex');
  }

  /**
   * Their payload to ours, or null if it is not something we act on.
   *
   * Null covers both "an event type we ignore" and "a shape we do not recognise", and the caller
   * answers 2xx to both — a 4xx makes the provider retry forever and eventually disable the
   * endpoint. What it must never do is guess: a missing period end or an unmapped status returns
   * null rather than a default, because every plausible default here grants somebody a month.
   */
  /**
   * A refunded order, or null.
   *
   * Refunds are an order event here — there is no `refunded` subscription status, which is what
   * left the entitlement rule for one unreachable until now. The order payload carries no
   * subscription id either: subscriptions have an `order_id`, not the reverse, so the caller
   * matches on the order id this returns.
   *
   * Only an actual refund. `order_refunded` arriving with `refunded` false is a shape we do not
   * understand, and revoking on it would take premium from somebody who still has it.
   */
  parseRefund(body: unknown): RefundEvent | null {
    if (body === null || typeof body !== 'object') return null;
    const payload = body as {
      meta?: { event_name?: string };
      data?: { id?: string; attributes?: { refunded?: boolean } };
    };
    if (payload.meta?.event_name !== 'order_refunded') return null;
    if (payload.data?.attributes?.refunded !== true) return null;
    if (!payload.data.id) return null;

    return { eventType: 'order_refunded', providerOrderId: String(payload.data.id) };
  }

  parse(body: unknown): SubscriptionEvent | null {
    // A JSON body can legitimately be `null`, and reading through it throws — which on the
    // webhook path is a 500, and a 500 is a delivery the provider retries forever. Everything
    // else here returns null to mean "not something we act on"; this has to as well.
    if (body === null || typeof body !== 'object') return null;

    const payload = body as {
      meta?: { event_name?: string; custom_data?: { user_id?: string | number } };
      data?: {
        id?: string;
        attributes?: {
          status?: string;
          order_id?: number | string;
          renews_at?: string | null;
          ends_at?: string | null;
          customer_id?: number | string;
          cancelled?: boolean;
        };
      };
    };

    const eventType = payload.meta?.event_name;
    const attributes = payload.data?.attributes;
    // The reader is identified by what we put in `custom_data` at checkout, never by an email
    // address on the payload — matching an account by email is how one person's payment ends up
    // entitling somebody else's account.
    const userId = payload.meta?.custom_data?.user_id;
    const providerSubscriptionId = payload.data?.id;

    if (!eventType?.startsWith('subscription_')) return null;
    // `subscription_reconciled` is ours, not theirs: a direct read carries no custom data, and
    // the reader is already known from the subscription row being reconciled.
    if (eventType !== 'subscription_reconciled' && !userId) return null;
    if (!providerSubscriptionId || !attributes) return null;

    const status = STATUS[attributes.status ?? ''];
    if (!status) return null;

    // Which field holds the truth depends on the status, and getting this backwards grants time
    // nobody paid for.
    //
    // `renews_at` is when the next invoice would be issued — and it stays populated on a
    // cancelled subscription, pointing at a renewal that will never happen. `ends_at` is set only
    // on cancelled and expired ones and is when access actually stops. Preferring `renews_at`
    // unconditionally, as the first version of this did, hands a cancelled subscriber entitlement
    // past the date they were told it ends.
    //
    // Both absent is a shape we do not understand, and inventing a date here is inventing
    // entitlement.
    const periodEnd = ENDED.includes(status)
      ? (attributes.ends_at ?? attributes.renews_at)
      : (attributes.renews_at ?? attributes.ends_at);
    if (!periodEnd) return null;
    const currentPeriodEnd = new Date(periodEnd);
    if (Number.isNaN(currentPeriodEnd.getTime())) return null;

    return {
      eventType,
      userId: userId === undefined ? '' : String(userId),
      providerSubscriptionId: String(providerSubscriptionId),
      providerCustomerId: String(attributes.customer_id ?? ''),
      providerOrderId: attributes.order_id === undefined ? null : String(attributes.order_id),
      status,
      currentPeriodEnd,
      cancelAtPeriodEnd: attributes.cancelled === true,
    };
  }
}
