import { createHmac } from 'node:crypto';
import { FakePaymentProvider } from '../src/billing/fake/fake-payment-provider';
import { LemonSqueezyAdapter } from '../src/billing/lemon-squeezy.adapter';
import type { PaymentProvider } from '../src/billing/payment-provider';

/**
 * The contract every payment provider owes, run against every implementation there is.
 *
 * This is the gate. When Lemon Squeezy is finally wired against a real store, or swapped for
 * Paddle, or anything else — the new implementation passes this or it is not finished. Nothing
 * else in the suite is written to survive a provider change; this is.
 *
 * The two implementations here agree on **no wire format whatsoever**: different envelopes,
 * different field names, ISO strings against seconds since the epoch. That disagreement is the
 * evidence that the port is a real seam rather than one provider's shape wearing an interface. If
 * a future edit makes it easier to write these cases by assuming a shape, the seam has gone.
 */

/** What each implementation must supply so the shared cases can be written once. */
interface Dialect {
  name: string;
  provider: PaymentProvider;
  secret: string;
  /** An ordinary active subscription for this reader, renewing at `renewsAt`. */
  active(userId: string, renewsAt: Date): unknown;
  /** Cancelled: still paid up, access ending at `endsAt`, and a renewal date that will not happen. */
  cancelled(userId: string, endsAt: Date, misleadingRenewsAt: Date): unknown;
  /** A status this implementation has never heard of. */
  unknownStatus(userId: string): unknown;
  /** Shaped right, but with no period end at all. */
  withoutPeriodEnd(userId: string): unknown;
  /** A refund of the whole order. */
  fullRefund(orderId: string): unknown;
  /** A refund of part of it — the reader is still subscribed and still paying. */
  partialRefund(orderId: string): unknown;
}

const USER = '00000000-0000-4000-8000-0000000000aa';

const lemonSqueezy: Dialect = {
  name: 'LemonSqueezyAdapter',
  provider: new LemonSqueezyAdapter({
    get: (key: string) =>
      ({
        LEMONSQUEEZY_WEBHOOK_SECRET: 'ls-secret',
        LEMONSQUEEZY_CHECKOUT_URL: 'https://pay.test/c',
      })[key],
  } as never),
  secret: 'ls-secret',
  active: (userId, renewsAt) => ({
    meta: { event_name: 'subscription_created', custom_data: { user_id: userId } },
    data: {
      id: 'sub_1',
      attributes: {
        status: 'active',
        renews_at: renewsAt.toISOString(),
        ends_at: null,
        customer_id: 1,
        order_id: 9,
        cancelled: false,
      },
    },
  }),
  cancelled: (userId, endsAt, misleadingRenewsAt) => ({
    meta: { event_name: 'subscription_cancelled', custom_data: { user_id: userId } },
    data: {
      id: 'sub_1',
      attributes: {
        status: 'cancelled',
        // Still populated on a cancelled subscription, pointing at a renewal that will not happen.
        renews_at: misleadingRenewsAt.toISOString(),
        ends_at: endsAt.toISOString(),
        customer_id: 1,
        order_id: 9,
        cancelled: true,
      },
    },
  }),
  unknownStatus: (userId) => ({
    meta: { event_name: 'subscription_updated', custom_data: { user_id: userId } },
    data: {
      id: 'sub_1',
      attributes: { status: 'levitating', renews_at: new Date().toISOString(), customer_id: 1 },
    },
  }),
  withoutPeriodEnd: (userId) => ({
    meta: { event_name: 'subscription_updated', custom_data: { user_id: userId } },
    data: {
      id: 'sub_1',
      attributes: { status: 'active', renews_at: null, ends_at: null, customer_id: 1 },
    },
  }),
  fullRefund: (orderId) => ({
    meta: { event_name: 'order_refunded' },
    data: {
      id: orderId,
      attributes: {
        refunded: true,
        refunded_at: '2026-09-01T00:00:00Z',
        total: 500,
        refunded_amount: 500,
      },
    },
  }),
  partialRefund: (orderId) => ({
    meta: { event_name: 'order_refunded' },
    data: {
      id: orderId,
      attributes: { refunded: true, refunded_at: null, total: 500, refunded_amount: 100 },
    },
  }),
};

const fake: Dialect = {
  name: 'FakePaymentProvider',
  provider: new FakePaymentProvider({
    get: (key: string) =>
      ({ FAKE_BILLING_SECRET: 'fake-secret', API_PUBLIC_URL: 'http://api.test' })[key],
  } as never),
  secret: 'fake-secret',
  active: (userId, renewsAt) => ({
    kind: 'subscription.activated',
    sub: 'fake_sub_1',
    buyer: userId,
    order: 'fake_ord_1',
    state: 'live',
    period_ends: Math.floor(renewsAt.getTime() / 1000),
    will_renew: true,
  }),
  cancelled: (userId, endsAt) => ({
    kind: 'subscription.cancelled',
    sub: 'fake_sub_1',
    buyer: userId,
    order: 'fake_ord_1',
    state: 'stopping',
    period_ends: Math.floor(endsAt.getTime() / 1000),
    will_renew: false,
  }),
  unknownStatus: (userId) => ({
    kind: 'subscription.updated',
    sub: 'fake_sub_1',
    buyer: userId,
    state: 'levitating',
    period_ends: Math.floor(Date.now() / 1000),
  }),
  withoutPeriodEnd: (userId) => ({
    kind: 'subscription.updated',
    sub: 'fake_sub_1',
    buyer: userId,
    state: 'live',
  }),
  fullRefund: (orderId) => ({
    kind: 'order.refunded',
    order: orderId,
    total_cents: 500,
    refunded_cents: 500,
  }),
  partialRefund: (orderId) => ({
    kind: 'order.refunded',
    order: orderId,
    total_cents: 500,
    refunded_cents: 100,
  }),
};

describe.each([lemonSqueezy, fake])('$name satisfies the payment provider contract', (dialect) => {
  const { provider, secret } = dialect;
  const raw = (body: unknown) => Buffer.from(JSON.stringify(body));
  const sign = (body: unknown, withSecret = secret) =>
    createHmac('sha256', withSecret).update(raw(body)).digest('hex');

  it('names itself', () => {
    expect(provider.provider).toEqual(expect.any(String));
    expect(provider.provider.length).toBeGreaterThan(0);
  });

  describe('identity of the reader', () => {
    it('reads an active subscription back to the reader who bought it', () => {
      const renewsAt = new Date(Date.now() + 30 * 86_400_000);

      const event = provider.parse(dialect.active(USER, renewsAt));

      expect(event).not.toBeNull();
      expect(event!.userId).toBe(USER);
      expect(event!.status).toBe('ACTIVE');
      // To the second: milliseconds do not survive a provider that counts in seconds.
      expect(Math.floor(event!.currentPeriodEnd.getTime() / 1000)).toBe(
        Math.floor(renewsAt.getTime() / 1000),
      );
    });
  });

  describe('a cancelled subscription', () => {
    it('reports when access ends, not a renewal that will never happen', () => {
      // The bug this exists for: preferring the renewal date unconditionally hands a cancelled
      // subscriber entitlement well past the date they were told it ends. It cost real money to
      // find in one implementation; every future one is now held to it before it ships.
      const endsAt = new Date(Date.now() + 3 * 86_400_000);
      const misleading = new Date(Date.now() + 33 * 86_400_000);

      const event = provider.parse(dialect.cancelled(USER, endsAt, misleading));

      expect(event).not.toBeNull();
      expect(event!.status).toBe('CANCELLED');
      expect(Math.floor(event!.currentPeriodEnd.getTime() / 1000)).toBe(
        Math.floor(endsAt.getTime() / 1000),
      );
      expect(event!.cancelAtPeriodEnd).toBe(true);
    });
  });

  describe('refusing rather than guessing', () => {
    it('returns null for a status it does not know', () => {
      // Never ACTIVE by default. Every plausible default here grants somebody a month.
      expect(provider.parse(dialect.unknownStatus(USER))).toBeNull();
    });

    it('returns null when there is no period end, rather than inventing one', () => {
      expect(provider.parse(dialect.withoutPeriodEnd(USER))).toBeNull();
    });

    it.each([
      ['null', null],
      ['a string', 'nope'],
      ['a number', 12],
      ['an array', [1, 2]],
      ['an empty object', {}],
    ])('returns null for %s without throwing', (_label, body) => {
      // Anything that throws on this path is a 500, and a 500 is a delivery the provider retries
      // until it gives up and disables the endpoint.
      expect(() => provider.parse(body)).not.toThrow();
      expect(provider.parse(body)).toBeNull();
      expect(() => provider.parseRefund(body)).not.toThrow();
      expect(provider.parseRefund(body)).toBeNull();
    });
  });

  describe('refunds', () => {
    it('reads a full refund as one that revokes', () => {
      const event = provider.parseRefund(dialect.fullRefund('ord_1'));

      expect(event).not.toBeNull();
      expect(event!.providerOrderId).toBe('ord_1');
      expect(event!.isFull).toBe(true);
    });

    it('reads a partial refund as one that does not', () => {
      // Entitlement is all-or-nothing, so a provider that cannot tell these apart will take
      // premium from somebody who is still subscribed and still paying for it.
      const event = provider.parseRefund(dialect.partialRefund('ord_1'));

      expect(event).not.toBeNull();
      expect(event!.isFull).toBe(false);
    });
  });

  describe('verification', () => {
    it('accepts a signature over the exact bytes', () => {
      const body = dialect.active(USER, new Date(Date.now() + 86_400_000));

      expect(provider.verify(raw(body), sign(body), secret)).toBe(true);
    });

    it('rejects a body altered after signing', () => {
      const body = dialect.active(USER, new Date(Date.now() + 86_400_000));
      const signature = sign(body);
      const altered = raw({ ...(body as object), tampered: true });

      expect(provider.verify(altered, signature, secret)).toBe(false);
    });

    it('rejects a signature made with another secret', () => {
      const body = dialect.active(USER, new Date(Date.now() + 86_400_000));

      expect(provider.verify(raw(body), sign(body, 'not-the-secret'), secret)).toBe(false);
    });

    it('rejects a missing signature without throwing', () => {
      const body = dialect.active(USER, new Date(Date.now() + 86_400_000));

      expect(() => provider.verify(raw(body), undefined, secret)).not.toThrow();
      expect(provider.verify(raw(body), undefined, secret)).toBe(false);
    });

    it('rejects a malformed signature without throwing', () => {
      // A length mismatch throws inside timingSafeEqual unless it is guarded, and that throw
      // would be a 500 rather than the rejection it should be.
      const body = dialect.active(USER, new Date(Date.now() + 86_400_000));

      expect(() => provider.verify(raw(body), 'zz', secret)).not.toThrow();
      expect(provider.verify(raw(body), 'zz', secret)).toBe(false);
    });
  });

  describe('idempotency', () => {
    it('gives the same key for a redelivery', () => {
      const body = dialect.active(USER, new Date(Date.now() + 86_400_000));

      expect(provider.idempotencyKey(raw(body))).toBe(provider.idempotencyKey(raw(body)));
    });

    it('gives a different key for a different delivery', () => {
      const one = dialect.active(USER, new Date(Date.now() + 86_400_000));
      const two = dialect.active(USER, new Date(Date.now() + 2 * 86_400_000));

      expect(provider.idempotencyKey(raw(one))).not.toBe(provider.idempotencyKey(raw(two)));
    });
  });

  describe('the checkout URL', () => {
    it('is absolute, so a browser can be sent to it', () => {
      const url = provider.checkoutUrlFor(USER);

      expect(url).not.toBeNull();
      expect(() => new URL(url as string)).not.toThrow();
    });

    it('carries no email address anywhere in it', () => {
      // Matching a payment to an account by email is how one person's money entitles another's.
      expect(provider.checkoutUrlFor(USER)).not.toMatch(/email/i);
    });
  });

  describe('the signing secret', () => {
    it('is whatever this instance was configured with', () => {
      expect(provider.signingSecret()).toBe(secret);
    });
  });
});
