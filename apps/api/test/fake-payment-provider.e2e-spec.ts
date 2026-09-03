import { createHmac } from 'node:crypto';
import { FakePaymentProvider } from '../src/billing/fake/fake-payment-provider';

/**
 * The provider that takes no money, against its own dialect.
 *
 * Pure: no app, no database. Its job is to be a *believable* provider, which means failing the
 * same ways a real one does — an unmapped status, a missing period end, a tampered byte — because
 * a fake that only ever succeeds tests nothing but the happy path.
 */
describe('FakePaymentProvider', () => {
  const SECRET = 'fake-billing-secret';
  /** Mirrors the schema's defaults, so a test never asserts against config the app cannot have. */
  const DEFAULTS: Record<string, unknown> = {
    FAKE_BILLING_SECRET: SECRET,
    API_PUBLIC_URL: 'http://localhost:3000',
  };
  const config = (values: Record<string, unknown> = {}) =>
    ({ get: (key: string) => (key in values ? values[key] : DEFAULTS[key]) }) as never;

  const provider = new FakePaymentProvider(config());

  /** Its dialect, which deliberately looks nothing like Lemon Squeezy's. */
  const payload = (over: Record<string, unknown> = {}) => ({
    kind: 'subscription.activated',
    sub: 'fake_sub_01',
    buyer: '00000000-0000-4000-8000-000000000001',
    order: 'fake_ord_01',
    state: 'live',
    period_ends: Math.floor(Date.now() / 1000) + 30 * 86_400,
    will_renew: true,
    paid: {
      cents: 500,
      currency: 'USD',
      receipt: 'fake_rcp_01',
      at: Math.floor(Date.now() / 1000),
    },
    ...over,
  });

  const sign = (body: unknown, secret = SECRET) =>
    createHmac('sha256', secret)
      .update(Buffer.from(JSON.stringify(body)))
      .digest('hex');

  it('identifies itself, so rows it writes are attributable after a provider swap', () => {
    expect(provider.provider).toBe('fake');
  });

  describe('parse', () => {
    it('reads its own dialect into the shared event', () => {
      const event = provider.parse(payload());

      expect(event).toMatchObject({
        userId: '00000000-0000-4000-8000-000000000001',
        providerSubscriptionId: 'fake_sub_01',
        providerOrderId: 'fake_ord_01',
        status: 'ACTIVE',
        cancelAtPeriodEnd: false,
      });
      // Seconds since the epoch on the wire, a Date in the event. Getting this wrong by a factor
      // of a thousand puts the period end in 1970 and revokes instantly.
      expect(event?.currentPeriodEnd.getTime()).toBeGreaterThan(Date.now());
    });

    it.each([
      ['live', 'ACTIVE'],
      ['dunning', 'PAST_DUE'],
      ['stopping', 'CANCELLED'],
      ['dead', 'EXPIRED'],
      ['clawed_back', 'REFUNDED'],
    ])('maps %s to %s', (state, status) => {
      expect(provider.parse(payload({ state }))?.status).toBe(status);
    });

    it('refuses a state it has never seen rather than defaulting to active', () => {
      // The rule the real adapter learned the hard way: a status nobody mapped must not quietly
      // become ACTIVE, because that grants a month to somebody who did not pay for one.
      expect(provider.parse(payload({ state: 'quantum' }))).toBeNull();
    });

    it.each([
      ['a null body', null],
      ['a string body', 'nope'],
      ['a number body', 7],
      ['an array body', []],
    ])('returns null for %s rather than throwing', (_label, body) => {
      // A throw here is a 500, and a 500 is a delivery the provider retries forever.
      expect(() => provider.parse(body)).not.toThrow();
      expect(provider.parse(body)).toBeNull();
    });

    it('refuses a payload with no period end, rather than inventing one', () => {
      expect(provider.parse(payload({ period_ends: undefined }))).toBeNull();
    });

    it('refuses a period end that is not a number', () => {
      expect(provider.parse(payload({ period_ends: 'tuesday' }))).toBeNull();
    });

    it('refuses a payload naming no subscription', () => {
      expect(provider.parse(payload({ sub: undefined }))).toBeNull();
    });

    it('refuses a payload naming no buyer', () => {
      // Without one there is nobody to entitle, and guessing is how one person's payment
      // entitles somebody else's account.
      expect(provider.parse(payload({ buyer: undefined }))).toBeNull();
    });

    it('refuses an empty buyer, not merely a missing one', () => {
      // Absent and empty are different shapes and only one of them was being checked.
      expect(provider.parse(payload({ buyer: '' }))).toBeNull();
    });

    it('refuses an empty subscription id', () => {
      // It is the unique key on the subscription row: two events carrying '' would upsert over
      // each other, and one reader's subscription would silently become another's.
      expect(provider.parse(payload({ sub: '' }))).toBeNull();
    });

    it('ignores an event that is not about a subscription', () => {
      expect(provider.parse(payload({ kind: 'invoice.printed' }))).toBeNull();
    });

    it('carries the payment through, so a receipt can be written', () => {
      const event = provider.parse(payload());

      expect(event?.payment).toMatchObject({
        providerReceiptId: 'fake_rcp_01',
        amountCents: 500,
        currency: 'USD',
      });
    });

    it('ignores a payment carrying no receipt reference', () => {
      // The receipt id is half of the unique key that makes writing one idempotent. An empty one
      // would collide with every other empty one, so the second payment ever made would vanish.
      expect(
        provider.parse(payload({ paid: { cents: 500, currency: 'USD', receipt: '' } }))?.payment,
      ).toBeUndefined();
    });

    it('leaves payment absent when the event took no money', () => {
      // A cancellation moves a subscription without charging anybody. Minting a receipt for it
      // would put a payment in someone's history that never happened.
      const event = provider.parse(payload({ state: 'stopping', paid: undefined }));

      expect(event?.status).toBe('CANCELLED');
      expect(event?.payment).toBeUndefined();
    });

    it('reads the renewal flag rather than assuming it', () => {
      expect(provider.parse(payload({ will_renew: false }))?.cancelAtPeriodEnd).toBe(true);
    });
  });

  describe('parseRefund', () => {
    it('reads a refund as the order it names', () => {
      expect(
        provider.parseRefund({
          kind: 'order.refunded',
          order: 'fake_ord_01',
          total_cents: 500,
          refunded_cents: 500,
        }),
      ).toEqual({
        eventType: 'order.refunded',
        providerOrderId: 'fake_ord_01',
        isFull: true,
      });
    });

    it('is null for anything that is not a refund', () => {
      expect(provider.parseRefund(payload())).toBeNull();
      expect(provider.parseRefund(null)).toBeNull();
    });

    it('marks a partial refund as one that must not revoke', () => {
      const event = provider.parseRefund({
        kind: 'order.refunded',
        order: 'fake_ord_01',
        total_cents: 500,
        refunded_cents: 100,
      });

      expect(event?.isFull).toBe(false);
    });

    it('will not claim a refund is full when it carries no amounts', () => {
      expect(provider.parseRefund({ kind: 'order.refunded', order: 'fake_ord_01' })?.isFull).toBe(
        false,
      );
    });

    it('is null for a refund naming no order, since there is nothing to match', () => {
      expect(provider.parseRefund({ kind: 'order.refunded' })).toBeNull();
    });
  });

  describe('verify', () => {
    it('accepts a signature over the exact bytes', () => {
      const body = payload();
      const raw = Buffer.from(JSON.stringify(body));

      expect(provider.verify(raw, sign(body), SECRET)).toBe(true);
    });

    it('rejects a single tampered byte', () => {
      const body = payload();
      const signature = sign(body);
      const tampered = Buffer.from(JSON.stringify({ ...body, paid: { cents: 1 } }));

      expect(provider.verify(tampered, signature, SECRET)).toBe(false);
    });

    it('rejects a signature made with a different secret', () => {
      const body = payload();
      expect(provider.verify(Buffer.from(JSON.stringify(body)), sign(body, 'other'), SECRET)).toBe(
        false,
      );
    });

    it('rejects a missing signature rather than throwing', () => {
      expect(provider.verify(Buffer.from('{}'), undefined, SECRET)).toBe(false);
    });

    it('rejects a signature of the wrong length without throwing', () => {
      // timingSafeEqual throws on a length mismatch, and a throw here would be a 500 the provider
      // retries rather than the rejection it should be.
      expect(() => provider.verify(Buffer.from('{}'), 'abc', SECRET)).not.toThrow();
      expect(provider.verify(Buffer.from('{}'), 'abc', SECRET)).toBe(false);
    });
  });

  describe('idempotencyKey', () => {
    it('is the same for the same bytes, which is what makes a redelivery a no-op', () => {
      expect(provider.idempotencyKey(Buffer.from('{"a":1}'))).toBe(
        provider.idempotencyKey(Buffer.from('{"a":1}')),
      );
    });

    it('differs for differing bytes', () => {
      expect(provider.idempotencyKey(Buffer.from('{"a":1}'))).not.toBe(
        provider.idempotencyKey(Buffer.from('{"a":2}')),
      );
    });
  });

  describe('checkoutUrlFor', () => {
    it('points at its own stand-in, carrying the reader id', () => {
      const withOrigin = new FakePaymentProvider(config({ API_PUBLIC_URL: 'http://api.test' }));

      const url = new URL(withOrigin.checkoutUrlFor('user-1') as string);

      expect(url.pathname).toBe('/api/v1/billing/fake-checkout');
      expect(url.searchParams.get('user_id')).toBe('user-1');
    });

    it('can always sell, because nothing external has to be configured', () => {
      // The whole point: a demo instance is never in the "subscriptions unavailable" state.
      expect(provider.checkoutUrlFor('user-1')).not.toBeNull();
    });

    it('answers null rather than throwing when its own base URL is unusable', () => {
      // This runs inside GET /billing/subscription. A throw would answer 500 on the very page
      // whose job is to report whether subscribing is possible.
      const broken = new FakePaymentProvider(config({ API_PUBLIC_URL: 'not a url' }));

      expect(() => broken.checkoutUrlFor('user-1')).not.toThrow();
      expect(broken.checkoutUrlFor('user-1')).toBeNull();
    });
  });

  describe('fetchSubscription', () => {
    it('cannot answer, and says so rather than guessing', async () => {
      // Null means "unknown" to the reconciliation job, which then leaves the subscription alone.
      // Anything else would have the demo's reconcile tick revoke real demo entitlement.
      await expect(provider.fetchSubscription('fake_sub_01')).resolves.toBeNull();
    });
  });
});
