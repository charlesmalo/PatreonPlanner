import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { WebhookSignatureService } from './webhook-signature.service';
import { WebhooksService } from './webhooks.service';

@Controller('webhooks')
export class WebhooksController {
  constructor(
    private readonly signatures: WebhookSignatureService,
    private readonly webhooks: WebhooksService,
  ) {}

  @Post('patreon')
  @HttpCode(204)
  async patreon(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-patreon-event') trigger: string | undefined,
    @Headers('x-patreon-signature') signature: string | undefined,
    @Body() body: unknown,
  ): Promise<void> {
    if (!req.rawBody || !this.signatures.verify(req.rawBody, signature)) {
      // Generic: a caller must not learn whether the secret, the body or the header was wrong.
      throw new UnauthorizedException();
    }
    // Anything accepted returns 204, including events we do not act on. Patreon retries
    // failures, and an event we will never handle would otherwise retry forever.
    await this.webhooks.handle(trigger, body as PledgeBody);
  }
}

type PledgeBody = Parameters<WebhooksService['handle']>[1];
