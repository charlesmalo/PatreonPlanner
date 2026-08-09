import { Module } from '@nestjs/common';
import { WebhookSignatureService } from './webhook-signature.service';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

@Module({
  controllers: [WebhooksController],
  providers: [WebhookSignatureService, WebhooksService],
})
export class WebhooksModule {}
