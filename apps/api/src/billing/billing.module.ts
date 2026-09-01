import { Module } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { BillingReconcileJob } from './billing-reconcile.job';
import { BillingService } from './billing.service';
import { EntitlementService } from './entitlement.service';
import { LemonSqueezyAdapter } from './lemon-squeezy.adapter';
import { PAYMENT_PROVIDER } from './payment-provider';

@Module({
  controllers: [BillingController],
  providers: [
    EntitlementService,
    BillingService,
    BillingReconcileJob,
    LemonSqueezyAdapter,
    // useExisting rather than useClass: one instance answers both, so a test that resolves the
    // concrete adapter and stubs a method is stubbing the same object the controller holds.
    { provide: PAYMENT_PROVIDER, useExisting: LemonSqueezyAdapter },
  ],
  exports: [EntitlementService, BillingService, BillingReconcileJob],
})
export class BillingModule {}
