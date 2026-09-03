import { LemonSqueezyAdapter } from '../src/billing/lemon-squeezy.adapter';

/**
 * The adapter against payload shapes taken from Lemon Squeezy's published documentation.
 *
 * Pure: no app, no database. What it holds down is the one thing the integration tests cannot,
 * because they use payloads I wrote — that the fields we read are the fields they send, and that
 * the fields we deliberately do not read stay unread.
 */
describe('LemonSqueezyAdapter shapes', () => {
  const adapter = new LemonSqueezyAdapter({ get: () => undefined } as never);

  /** A retrieved subscription, JSON:API shaped, carrying the PII their response really includes. */
  const retrieved = (attributes: Record<string, unknown> = {}) => ({
    meta: { event_name: 'subscription_reconciled' },
    data: {
      type: 'subscriptions',
      id: '1',
      attributes: {
        store_id: 1,
        customer_id: 4242,
        order_id: 9,
        product_name: 'Premium',
        user_name: 'Ada Lovelace',
        user_email: 'ada@example.com',
        status: 'active',
        status_formatted: 'Active',
        card_brand: 'visa',
        card_last_four: '4242',
        payment_processor: 'stripe',
        cancelled: false,
        trial_ends_at: null,
        renews_at: '2026-10-01T00:00:00.000000Z',
        ends_at: null,
        created_at: '2026-09-01T00:00:00.000000Z',
        ...attributes,
      },
    },
  });

  it('reads a retrieved subscription without a meta block of its own', () => {
    // A direct read carries no custom_data — the reader is already known from the row being
    // reconciled — so the parse must not require it the way a webhook does.
    const parsed = adapter.parse(retrieved());

    expect(parsed).toMatchObject({
      providerSubscriptionId: '1',
      providerCustomerId: '4242',
      status: 'ACTIVE',
      cancelAtPeriodEnd: false,
    });
    expect(parsed?.currentPeriodEnd.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  it('takes none of the personal data the response carries', () => {
    // Their retrieve response includes user_email, user_name, card_brand and card_last_four. The
    // promise that this application holds no billing PII is kept by this parse reading only what
    // it names — anything that copied attributes wholesale would break it silently.
    const parsed = adapter.parse(retrieved()) as unknown as Record<string, unknown>;

    const leaked = Object.entries(parsed).filter(([, value]) =>
      /ada@example\.com|Ada Lovelace|visa|4242$/.test(String(value)),
    );
    // customer_id is 4242 and is ours to hold; a card's last four is not.
    expect(leaked.map(([key]) => key)).toEqual(['providerCustomerId']);
    expect(Object.keys(parsed).sort()).toEqual([
      'cancelAtPeriodEnd',
      'currentPeriodEnd',
      'eventType',
      'providerCustomerId',
      // An order id, like a customer id, is the provider's own identifier rather than anything
      // about the person. This list growing is meant to be a deliberate act, which is why it is
      // written out rather than derived.
      'providerOrderId',
      'providerSubscriptionId',
      'status',
      'userId',
    ]);
  });

  it.each([
    ['active', 'ACTIVE'],
    ['on_trial', 'ACTIVE'],
    ['paused', 'ACTIVE'],
    ['past_due', 'PAST_DUE'],
    ['unpaid', 'PAST_DUE'],
    ['cancelled', 'CANCELLED'],
    ['expired', 'EXPIRED'],
  ])('maps their %s to our %s', (theirs, ours) => {
    // Every status their documentation lists. A provider adding an eighth should make this fail
    // to compile against reality rather than quietly granting somebody a month.
    const parsed = adapter.parse(
      retrieved({ status: theirs, ends_at: '2026-10-01T00:00:00.000000Z' }),
    );

    expect(parsed?.status).toBe(ours);
  });

  it('prefers ends_at once a subscription is cancelled', () => {
    const parsed = adapter.parse(
      retrieved({
        status: 'cancelled',
        cancelled: true,
        ends_at: '2026-09-10T00:00:00.000000Z',
        renews_at: '2026-10-01T00:00:00.000000Z',
      }),
    );

    expect(parsed?.currentPeriodEnd.toISOString()).toBe('2026-09-10T00:00:00.000Z');
  });

  it('refuses a response that is not the shape it expects', () => {
    // Reconciliation treats null as "unknown" and leaves entitlement alone, so a shape change
    // costs a stale subscription rather than a revoked one.
    expect(adapter.parse({ data: { id: '1' } })).toBeNull();
    expect(adapter.parse({})).toBeNull();
    expect(adapter.parse(null)).toBeNull();
  });

  /**
   * Refunds, and the difference between some of the money and all of it.
   *
   * Their order object carries `refunded` (a boolean), `refunded_at`, `refunded_amount` in cents,
   * and `total`. What their documentation does *not* say is what `refunded` does on a **partial**
   * refund — and the first version of this revoked entitlement on that flag alone.
   *
   * If the flag is shared, a $1 goodwill refund on a $5 order took somebody's premium away
   * outright. That fails in the direction nobody reports: they paid, they still hold a
   * subscription, and the thing they paid for is gone.
   *
   * So the flag is no longer trusted on its own. A refund revokes only when the amount refunded
   * covers the order, which is arithmetic rather than an assumption about a field.
   */
  describe('refunds', () => {
    const order = (attributes: Record<string, unknown>) => ({
      meta: { event_name: 'order_refunded' },
      data: {
        type: 'orders',
        id: '9',
        attributes: {
          refunded: true,
          refunded_at: '2026-09-01T00:00:00.000000Z',
          total: 500,
          refunded_amount: 500,
          // The PII their real payload carries, none of which may be read.
          user_name: 'Ada Lovelace',
          user_email: 'ada@example.com',
          ...attributes,
        },
      },
    });

    it('reads a full refund as one that revokes', () => {
      expect(adapter.parseRefund(order({}))).toMatchObject({
        providerOrderId: '9',
        isFull: true,
      });
    });

    it('reads a partial refund as one that does not', () => {
      // $1 back on a $5 order. They still have a subscription and still paid for it.
      expect(adapter.parseRefund(order({ refunded_amount: 100, refunded_at: null }))).toMatchObject(
        { isFull: false },
      );
    });

    it('does not treat a partial refund as full merely because the flag is set', () => {
      // The exact shape the old code got wrong: `refunded` true, but not all of the money.
      const event = adapter.parseRefund(order({ refunded: true, refunded_amount: 100 }));

      expect(event).not.toBeNull();
      expect(event!.isFull).toBe(false);
    });

    it('treats an over-refund as full rather than as neither', () => {
      // Currency rounding and goodwill top-ups can put the refunded amount above the total.
      expect(adapter.parseRefund(order({ refunded_amount: 501 }))!.isFull).toBe(true);
    });

    it('will not revoke when it cannot tell how much came back', () => {
      // No amount to compare. Refusing to revoke is the safe direction: wrongly keeping premium
      // costs a month, wrongly removing it punishes somebody who paid.
      expect(adapter.parseRefund(order({ refunded_amount: undefined }))!.isFull).toBe(false);
    });

    it('ignores an order_refunded that says it was not refunded', () => {
      expect(adapter.parseRefund(order({ refunded: false }))).toBeNull();
    });

    it('reads none of the person off the order', () => {
      const event = adapter.parseRefund(order({}));

      expect(JSON.stringify(event)).not.toMatch(/Ada|ada@example/);
    });
  });
});
