import { LemonSqueezyAdapter } from '../src/billing/lemon-squeezy.adapter';
import { PAYMENT_PROVIDER, type PaymentProvider } from '../src/billing/payment-provider';

/**
 * That the real adapter actually satisfies the port.
 *
 * Pure: no app, no database. TypeScript proves the shape at compile time, but only for code that
 * declares the type — this asserts it at runtime so a member quietly dropped during a refactor
 * fails here rather than at the first webhook of the month.
 */
describe('the payment provider port', () => {
  const config = (values: Record<string, string> = {}) =>
    ({ get: (key: string) => values[key] }) as never;

  it('is a symbol, so two providers cannot collide on a string token', () => {
    expect(typeof PAYMENT_PROVIDER).toBe('symbol');
  });

  it('is satisfied by the Lemon Squeezy adapter', () => {
    // Assigned through the interface: if a member is missing this does not compile, and if one
    // is present but wrongly typed it does not either.
    const provider: PaymentProvider = new LemonSqueezyAdapter(config());

    for (const member of [
      'checkoutUrlFor',
      'signingSecret',
      'verify',
      'idempotencyKey',
      'parse',
      'parseRefund',
      'fetchSubscription',
    ]) {
      expect(typeof (provider as unknown as Record<string, unknown>)[member]).toBe('function');
    }
    expect(provider.provider).toBe('lemonsqueezy');
  });

  describe('checkoutUrlFor', () => {
    it('carries the reader id as custom data, and never an email address', () => {
      const provider = new LemonSqueezyAdapter(
        config({ LEMONSQUEEZY_CHECKOUT_URL: 'https://store.lemonsqueezy.com/checkout/buy/abc' }),
      );

      const url = new URL(provider.checkoutUrlFor('user-1') as string);

      expect(url.searchParams.get('checkout[custom][user_id]')).toBe('user-1');
      // The whole query string, not just the field we set: matching a payment to an account by
      // email is how one person's money entitles somebody else's account.
      expect(url.search).not.toMatch(/email/i);
    });

    it('keeps a query string the checkout URL already had', () => {
      // Store URLs carry things like ?discount=0. Rebuilding the URL rather than appending would
      // silently drop them, and the reader would be charged the wrong price.
      const provider = new LemonSqueezyAdapter(
        config({
          LEMONSQUEEZY_CHECKOUT_URL: 'https://store.lemonsqueezy.com/checkout/buy/abc?discount=0',
        }),
      );

      const url = new URL(provider.checkoutUrlFor('user-1') as string);

      expect(url.searchParams.get('discount')).toBe('0');
      expect(url.searchParams.get('checkout[custom][user_id]')).toBe('user-1');
    });

    it('is null when this instance has no checkout configured', () => {
      // Null rather than a throw: "cannot sell" is an ordinary state for a self-hosted instance,
      // and the page that asks needs an answer rather than an exception.
      expect(new LemonSqueezyAdapter(config()).checkoutUrlFor('user-1')).toBeNull();
    });
  });

  describe('signingSecret', () => {
    it('is whatever the provider was configured with', () => {
      const provider = new LemonSqueezyAdapter(config({ LEMONSQUEEZY_WEBHOOK_SECRET: 'shh' }));
      expect(provider.signingSecret()).toBe('shh');
    });

    it('is undefined when unset, which is what makes the webhook refuse', () => {
      expect(new LemonSqueezyAdapter(config()).signingSecret()).toBeUndefined();
    });
  });
});
