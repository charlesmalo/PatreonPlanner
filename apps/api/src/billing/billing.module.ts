import { Module } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { BillingReconcileJob } from './billing-reconcile.job';
import { BillingService } from './billing.service';
import { EntitlementService } from './entitlement.service';
import { LemonSqueezyAdapter } from './lemon-squeezy.adapter';

@Module({
  controllers: [BillingController],
  providers: [EntitlementService, BillingService, LemonSqueezyAdapter, BillingReconcileJob],
  exports: [EntitlementService, BillingService, BillingReconcileJob],
})
export class BillingModule {}
