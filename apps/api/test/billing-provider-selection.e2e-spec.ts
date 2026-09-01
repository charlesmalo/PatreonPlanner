import { selectPaymentProvider } from '../src/billing/select-payment-provider';
import type { PaymentProvider } from '../src/billing/payment-provider';

/**
 * Which provider an instance runs, and the one combination it must refuse.
 *
 * A fake payment provider is, by definition, a way to become premium without paying. Everything
 * here is about making that unreachable by accident while keeping it one config value away on
 * purpose.
 */
describe('selecting a payment provider', () => {
  const lemonsqueezy = { provider: 'lemonsqueezy' } as PaymentProvider;
  const fake = { provider: 'fake' } as PaymentProvider;
  const both = { lemonsqueezy, fake };

  const config = (values: Record<string, unknown>) =>
    ({
      get: (key: string) =>
        key in values
          ? values[key]
          : {
              NODE_ENV: 'test',
              BILLING_PROVIDER: 'lemonsqueezy',
              ALLOW_FAKE_BILLING_IN_PRODUCTION: false,
            }[key],
    }) as never;

  it('runs the real provider by default', () => {
    // The default has to be the safe one. An instance that forgot to configure billing gets an
    // adapter that cannot sell and refuses every webhook, which is exactly right — not one that
    // hands out premium.
    expect(selectPaymentProvider(config({}), both).provider).toBe('lemonsqueezy');
  });

  it('runs the fake when asked', () => {
    expect(selectPaymentProvider(config({ BILLING_PROVIDER: 'fake' }), both).provider).toBe('fake');
  });

  it('runs the fake in development without ceremony', () => {
    expect(
      selectPaymentProvider(config({ BILLING_PROVIDER: 'fake', NODE_ENV: 'development' }), both)
        .provider,
    ).toBe('fake');
  });

  describe('in production', () => {
    const production = { NODE_ENV: 'production', BILLING_PROVIDER: 'fake' };

    it('refuses the fake outright', () => {
      // One key is a typo away from free premium for everybody. This is the load-bearing test.
      expect(() => selectPaymentProvider(config(production), both)).toThrow(
        /ALLOW_FAKE_BILLING_IN_PRODUCTION/,
      );
    });

    it('allows it only when a second, separate key says so', () => {
      const allowed = { ...production, ALLOW_FAKE_BILLING_IN_PRODUCTION: true };

      expect(selectPaymentProvider(config(allowed), both).provider).toBe('fake');
    });

    it('still runs the real provider without any of that', () => {
      expect(selectPaymentProvider(config({ NODE_ENV: 'production' }), both).provider).toBe(
        'lemonsqueezy',
      );
    });

    it('ignores the permission flag when the fake was not asked for', () => {
      // Setting the escape hatch must not itself select the fake — that would make one stray
      // variable enough, which is the whole thing this design is avoiding.
      const flagOnly = { NODE_ENV: 'production', ALLOW_FAKE_BILLING_IN_PRODUCTION: true };

      expect(selectPaymentProvider(config(flagOnly), both).provider).toBe('lemonsqueezy');
    });
  });
});
