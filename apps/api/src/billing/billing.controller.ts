import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { ConfigService } from '../config/config.module';
import { CurrentUser, CurrentUserPayload, SessionGuard } from '../session/session.guard';
import { BillingService } from './billing.service';
import { LemonSqueezyAdapter } from './lemon-squeezy.adapter';

@Controller('billing')
export class BillingController {
  constructor(
    private readonly config: ConfigService,
    private readonly billing: BillingService,
    private readonly adapter: LemonSqueezyAdapter,
  ) {}

  /**
   * Where the provider tells us what happened.
   *
   * Unauthenticated by design — the provider has no session — and therefore authorised entirely
   * by the signature over the raw bytes. Everything downstream trusts this endpoint, so it is the
   * one place in the application where getting verification wrong hands out entitlement.
   */
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  async webhook(@Req() request: Request & { rawBody?: Buffer }) {
    const secret = this.config.get('LEMONSQUEEZY_WEBHOOK_SECRET');
    // No secret means no way to tell a real delivery from anybody's POST. Refusing is the only
    // safe answer; an instance that does not sell anything has no webhooks to receive.
    if (!secret) throw new UnauthorizedException();

    const rawBody = request.rawBody;
    if (!rawBody) throw new BadRequestException();

    const signature = header(request, 'x-signature');
    if (!this.adapter.verify(rawBody, signature, secret)) {
      throw new UnauthorizedException();
    }

    const event = this.adapter.parse(request.body);
    // Something we do not act on, or a shape we do not recognise. Answered 2xx deliberately: a
    // 4xx makes the provider retry it forever and eventually disable the endpoint, and neither
    // outcome is improved by us insisting.
    if (!event) return { ok: true, handled: false };

    const applied = await this.billing.applyEvent(
      this.adapter.provider,
      this.adapter.idempotencyKey(rawBody),
      event,
    );
    return { ok: true, handled: applied };
  }

  /**
   * What this reader's subscription looks like, for the page that shows it.
   *
   * Reads the subscription rather than `premiumUntil` because the page says more than yes or no —
   * when it renews, and whether it is set to stop. The gates elsewhere still read the projection.
   */
  @Get('subscription')
  @UseGuards(SessionGuard)
  async subscription(@CurrentUser() user: CurrentUserPayload) {
    const subscription = await this.billing.forUser(user.id);
    return {
      available: this.config.get('LEMONSQUEEZY_CHECKOUT_URL') !== undefined,
      subscription,
    };
  }

  /**
   * Where to send somebody who wants to subscribe.
   *
   * Their user id rides along as the provider's custom data, which is what the webhook reads back
   * — never an email address. Matching a payment to an account by email is how one person's
   * money ends up entitling somebody else's account.
   */
  @Post('checkout')
  @UseGuards(SessionGuard)
  checkout(@CurrentUser() user: CurrentUserPayload) {
    const base = this.config.get('LEMONSQUEEZY_CHECKOUT_URL');
    if (!base) throw new BadRequestException('Subscriptions are not available here');

    const url = new URL(base);
    url.searchParams.set('checkout[custom][user_id]', user.id);
    return { url: url.toString() };
  }
}

/** Express lowercases header names; duplicates arrive joined, which a signature check rejects. */
function header(request: Request, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value.join(', ') : value;
}
