import { Module } from '@nestjs/common';
import { WebhookSignatureGuard } from './webhook-signature.guard';
import { WebhookSignatureService } from './webhook-signature.service';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

@Module({
  controllers: [WebhooksController],
  providers: [WebhookSignatureService, WebhookSignatureGuard, WebhooksService],
})
export class WebhooksModule {}
