import { Logger } from '@nestjs/common';
import { ConfigService } from '../config/config.module';
import type { PaymentProvider } from './payment-provider';

/**
 * Which payment provider this instance runs.
 *
 * A pure function rather than logic inside the module factory, because the rule it enforces is
 * the most consequential one in `billing/` and deserves to be tested without standing up a Nest
 * application to do it.
 *
 * There is no `none` option. An unconfigured `LemonSqueezyAdapter` already *is* "none" — it
 * cannot sell, because there is no checkout URL, and it refuses every webhook, because there is
 * no signing secret. A third implementation would be a second way to spell a state that already
 * has one.
 */
export function selectPaymentProvider(
  config: ConfigService,
  providers: { lemonsqueezy: PaymentProvider; fake: PaymentProvider },
): PaymentProvider {
  // Defaults to the real one. An instance that forgot to configure billing must end up with an
  // adapter that sells nothing, never with one that hands out premium.
  if (config.get('BILLING_PROVIDER') !== 'fake') return providers.lemonsqueezy;

  if (config.get('NODE_ENV') === 'production' && !config.get('ALLOW_FAKE_BILLING_IN_PRODUCTION')) {
    // Thrown at boot rather than warned about, and thrown from here rather than checked at the
    // checkout route: a process that would hand out free premium should not start, and should
    // say why in the one place somebody is already looking when it does not.
    throw new Error(
      'BILLING_PROVIDER=fake refuses to run under NODE_ENV=production. The fake provider grants ' +
        'premium to anyone who asks for it, and no money changes hands. If this really is a demo ' +
        'deployment, set ALLOW_FAKE_BILLING_IN_PRODUCTION=true as well — deliberately a second ' +
        'key, because one is a typo away from giving the product away.',
    );
  }

  // Loud, every boot, for the deployment that did set both keys. The failure mode this guards
  // against is a demo instance quietly outliving the demo.
  new Logger('Billing').warn(
    'Running the FAKE payment provider: subscriptions are granted without payment. ' +
      'Nobody is being charged, and nothing here is a real transaction.',
  );
  return providers.fake;
}
