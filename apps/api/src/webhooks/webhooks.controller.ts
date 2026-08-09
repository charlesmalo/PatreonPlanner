import { Body, Controller, Headers, HttpCode, Post, UseGuards } from '@nestjs/common';
import { VerifiedCreator, WebhookCreator, WebhookSignatureGuard } from './webhook-signature.guard';
import { WebhooksService } from './webhooks.service';

/**
 * The path carries the creator so the right secret can be selected *before* the body is
 * trusted. Patreon issues one secret per webhook, and each creator registers their own.
 */
@Controller('webhooks/patreon')
@UseGuards(WebhookSignatureGuard)
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Post(':creatorId')
  @HttpCode(204)
  async patreon(
    @VerifiedCreator() creator: WebhookCreator,
    @Headers('x-patreon-event') trigger: string | undefined,
    // Deliberately untyped here: the global ValidationPipe's forbidNonWhitelisted would reject
    // Patreon's other event shapes outright, and they must be accepted-and-ignored rather than
    // retried forever. WebhooksService validates the shapes it actually acts on.
    @Body() body: unknown,
  ): Promise<void> {
    // Anything accepted returns 204, including events we do not act on. Patreon retries
    // failures, and an event we will never handle would otherwise retry forever.
    await this.webhooks.handle(creator, trigger, body);
  }
}
