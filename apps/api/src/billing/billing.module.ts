import { Module } from '@nestjs/common';
import { ConfigService } from '../config/config.module';
import { BillingController } from './billing.controller';
import { BillingReconcileJob } from './billing-reconcile.job';
import { BillingService } from './billing.service';
import { EntitlementService } from './entitlement.service';
import { FakeCheckoutController } from './fake/fake-checkout.controller';
import { FakePaymentProvider } from './fake/fake-payment-provider';
import { LemonSqueezyAdapter } from './lemon-squeezy.adapter';
import { PAYMENT_PROVIDER } from './payment-provider';
import { ReceiptService } from './receipt.service';
import { selectPaymentProvider } from './select-payment-provider';
import { WebhookIngestService } from './webhook-ingest.service';

@Module({
  // The stand-in is mounted unconditionally and refuses at the door when the fake provider is not
  // the one running. Conditional controller registration would make the route's existence depend
  // on config, and a route that vanishes is much harder to diagnose than one that answers 404
  // with a reason.
  controllers: [BillingController, FakeCheckoutController],
  providers: [
    EntitlementService,
    BillingService,
    BillingReconcileJob,
    WebhookIngestService,
    ReceiptService,
    LemonSqueezyAdapter,
    FakePaymentProvider,
    {
      provide: PAYMENT_PROVIDER,
      inject: [ConfigService, LemonSqueezyAdapter, FakePaymentProvider],
      // Both are constructed either way, which costs nothing — they hold a ConfigService and no
      // state — and means the one that is chosen is chosen by a function under test rather than
      // by which import happened to run.
      useFactory: (
        config: ConfigService,
        lemonsqueezy: LemonSqueezyAdapter,
        fake: FakePaymentProvider,
      ) => selectPaymentProvider(config, { lemonsqueezy, fake }),
    },
  ],
  exports: [EntitlementService, BillingService, BillingReconcileJob],
})
export class BillingModule {}
