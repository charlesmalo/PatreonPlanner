import { Module } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { EntitlementService } from './entitlement.service';
import { LemonSqueezyAdapter } from './lemon-squeezy.adapter';

@Module({
  controllers: [BillingController],
  providers: [EntitlementService, BillingService, LemonSqueezyAdapter],
  exports: [EntitlementService, BillingService],
})
export class BillingModule {}
