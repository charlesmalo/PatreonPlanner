import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { SubscriptionStatus } from '@prisma/client';
import { ConfigService } from '../../config/config.module';
import type { PaymentProvider, RefundEvent, SubscriptionEvent } from '../payment-provider';

/**
 * A payment provider that takes no money.
 *
 * It exists so the whole product can be demonstrated — subscribe, become premium, use the premium
 * controls, get refunded, lose them — before anybody has a merchant account. Everything downstream
 * of `parse` is the same code a real payment runs through.
 *
 * **Its dialect deliberately resembles nothing.** Different envelope, different field names,
 * seconds since the epoch instead of ISO strings, the payment inline instead of on a separate
 * order object. That is the point: if this and `LemonSqueezyAdapter` both satisfy
 * `PaymentProvider` while agreeing on no wire format whatsoever, then the port is a real seam
 * rather than Lemon Squeezy's shape wearing an interface. A fake that mirrored the real payload
 * would let provider assumptions leak straight through while every test still passed.
 *
 * It is never reachable by accident: `BillingModule` refuses to construct it under
 * `NODE_ENV=production` unless a second, deliberately awkward flag is also set. See that file.
 */

/** Its vocabulary to ours. Unmapped is null, for the same reason it is in the real adapter. */
const STATUS: Record<string, SubscriptionStatus> = {
  live: 'ACTIVE',
  dunning: 'PAST_DUE',
  stopping: 'CANCELLED',
  dead: 'EXPIRED',
  clawed_back: 'REFUNDED',
};

@Injectable()
export class FakePaymentProvider implements PaymentProvider {
  readonly provider = 'fake';

  constructor(private readonly config: ConfigService) {}

  /**
   * Its own checkout stand-in, served by this API.
   *
   * Never null: an instance running the fake provider can always "sell", which is what keeps the
   * demo out of the "subscriptions are not available here" state that a real, unconfigured
   * instance sits in.
   */
  checkoutUrlFor(userId: string): string | null {
    // Wrapped because `new URL` throws on a base it cannot parse, and this runs inside
    // GET /billing/subscription — an unparseable API_PUBLIC_URL would answer 500 on the page
    // that exists to say whether subscribing is possible. Null is the honest answer, and the
    // page already knows how to render it.
    try {
      const url = new URL('/api/v1/billing/fake-checkout', this.config.get('API_PUBLIC_URL'));
      url.searchParams.set('user_id', userId);
      return url.toString();
    } catch {
      return null;
    }
  }

  /**
   * Shared with the stand-in that signs the payloads, so the demo exercises real verification
   * rather than a path that skips it. It has a default precisely because it protects nothing —
   * there is no money behind it — but the code path it drives is the real one.
   */
  signingSecret(): string | undefined {
    return this.config.get('FAKE_BILLING_SECRET');
  }

  /** Byte-for-byte the real adapter's check. Verification is not the part worth faking. */
  verify(rawBody: Buffer, signature: string | undefined, secret: string): boolean {
    if (!signature) return false;
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    const provided = Buffer.from(signature, 'utf8');
    const computed = Buffer.from(expected, 'utf8');
    // Length first: timingSafeEqual throws on a mismatch, and a throw here would be a 500.
    return provided.length === computed.length && timingSafeEqual(provided, computed);
  }

  idempotencyKey(rawBody: Buffer): string {
    return createHash('sha256').update(rawBody).digest('hex');
  }

  parse(body: unknown): SubscriptionEvent | null {
    const payload = asObject(body);
    if (!payload) return null;

    const kind = payload.kind;
    if (typeof kind !== 'string' || !kind.startsWith('subscription.')) return null;

    const providerSubscriptionId = payload.sub;
    const userId = payload.buyer;
    if (typeof providerSubscriptionId !== 'string' || !providerSubscriptionId) return null;
    // No buyer means nobody to entitle. Guessing is how one person's payment entitles another's
    // account, so this refuses instead.
    if (typeof userId !== 'string' || !userId) return null;

    const status = STATUS[typeof payload.state === 'string' ? payload.state : ''];
    if (!status) return null;

    // Seconds since the epoch, as plenty of real providers send. Multiplying is the whole
    // conversion, and forgetting to would put every period end in 1970 and revoke on arrival.
    const periodEnds = payload.period_ends;
    if (typeof periodEnds !== 'number' || !Number.isFinite(periodEnds)) return null;
    const currentPeriodEnd = new Date(periodEnds * 1000);
    if (Number.isNaN(currentPeriodEnd.getTime())) return null;

    return {
      eventType: kind,
      userId,
      providerSubscriptionId,
      providerCustomerId: typeof payload.customer === 'string' ? payload.customer : '',
      providerOrderId: typeof payload.order === 'string' ? payload.order : null,
      status,
      currentPeriodEnd,
      // Absent means "renews", the ordinary case; only an explicit false is a cancellation.
      cancelAtPeriodEnd: payload.will_renew === false,
      ...paymentFrom(payload.paid),
    };
  }

  parseRefund(body: unknown): RefundEvent | null {
    const payload = asObject(body);
    if (!payload) return null;
    if (payload.kind !== 'order.refunded') return null;
    if (typeof payload.order !== 'string' || !payload.order) return null;

    // Its own dialect for the same distinction: how much came back, against what was charged.
    const back = payload.refunded_cents;
    const charged = payload.total_cents;
    return {
      eventType: 'order.refunded',
      providerOrderId: payload.order,
      isFull: typeof back === 'number' && typeof charged === 'number' && back >= charged,
    };
  }

  /**
   * There is no provider to ask.
   *
   * Null means "could not answer", which is exactly what the reconciliation job needs to hear: it
   * then leaves the subscription alone. Returning anything else would have the demo's reconcile
   * tick quietly revoke entitlement the demo just granted.
   */
  async fetchSubscription(_providerSubscriptionId: string): Promise<SubscriptionEvent | null> {
    return null;
  }
}

/** Arrays excluded: `typeof [] === 'object'`, and an array has none of the fields we read. */
function asObject(body: unknown): Record<string, unknown> | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  return body as Record<string, unknown>;
}

/**
 * The charge, if this event carried one.
 *
 * Spread into the event so an event with no payment has no `payment` key at all rather than an
 * undefined one — the receipt writer keys off its presence, and `{ payment: undefined }` would
 * read as a payment of nothing.
 */
function paymentFrom(paid: unknown): Pick<SubscriptionEvent, 'payment'> | Record<string, never> {
  const payment = asObject(paid);
  if (!payment) return {};

  const { cents, currency, receipt, at } = payment;
  if (typeof cents !== 'number' || typeof receipt !== 'string' || !receipt) return {};

  return {
    payment: {
      providerReceiptId: receipt,
      amountCents: cents,
      currency: typeof currency === 'string' ? currency : 'USD',
      paidAt: typeof at === 'number' ? new Date(at * 1000) : new Date(),
      // No provider hosts a receipt for a payment that did not happen.
      url: null,
    },
  };
}
