import {
  BadRequestException,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { ResendWebhookAdapter } from './resend-webhook.adapter';
import { SuppressionService } from './suppression.service';

/**
 * Where Resend reports a bounce or a complaint.
 *
 * Unauthenticated by design — the provider has no session — and therefore authorised entirely by
 * the signature over the raw bytes. At the root rather than under `/api/v1`, like the Patreon
 * webhook, because the URL is registered with somebody else and changing it later means editing
 * their settings.
 */
@Controller('webhooks/resend')
export class ResendWebhookController {
  constructor(
    private readonly adapter: ResendWebhookAdapter,
    private readonly suppressions: SuppressionService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async receive(@Req() request: Request & { rawBody?: Buffer }) {
    // No secret means no way to tell a real delivery from anybody's POST — and this endpoint can
    // stop mail reaching a reader, so an unverified one is a denial of service with a curl.
    if (!this.adapter.signingSecret()) throw new UnauthorizedException();

    const rawBody = request.rawBody;
    if (!rawBody) throw new BadRequestException();

    const verified = this.adapter.verify(rawBody, {
      id: header(request, 'svix-id'),
      timestamp: header(request, 'svix-timestamp'),
      signature: header(request, 'svix-signature'),
    });
    if (!verified) throw new UnauthorizedException();

    // Everything else — deliveries, opens, clicks, a temporary bounce — parses to nothing and is
    // answered 2xx. A 4xx would have the provider retry it forever and then disable the endpoint.
    const suppressed = await this.suppressions.suppress(this.adapter.parse(request.body));
    return { ok: true, suppressed };
  }
}

/** Express lowercases header names; duplicates arrive joined, which a signature check rejects. */
function header(request: Request, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value.join(', ') : value;
}
