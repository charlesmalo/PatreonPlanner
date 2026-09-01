import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { CurrentUser, CurrentUserPayload, SessionGuard } from '../session/session.guard';
import { BillingService } from './billing.service';
import { PAYMENT_PROVIDER, type PaymentProvider } from './payment-provider';

@Controller('billing')
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
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
    const secret = this.provider.signingSecret();
    // No secret means no way to tell a real delivery from anybody's POST. Refusing is the only
    // safe answer; an instance that does not sell anything has no webhooks to receive.
    if (!secret) throw new UnauthorizedException();

    const rawBody = request.rawBody;
    if (!rawBody) throw new BadRequestException();

    const signature = header(request, 'x-signature');
    if (!this.provider.verify(rawBody, signature, secret)) {
      throw new UnauthorizedException();
    }

    // Refunds first: they are an order event, and the subscription parse would reject one anyway.
    const refund = this.provider.parseRefund(request.body);
    if (refund) {
      const applied = await this.billing.applyRefund(
        this.provider.provider,
        this.provider.idempotencyKey(rawBody),
        refund,
      );
      return { ok: true, handled: applied };
    }

    const event = this.provider.parse(request.body);
    // Something we do not act on, or a shape we do not recognise. Answered 2xx deliberately: a
    // 4xx makes the provider retry it forever and eventually disable the endpoint, and neither
    // outcome is improved by us insisting.
    if (!event) return { ok: true, handled: false };

    const applied = await this.billing.applyEvent(
      this.provider.provider,
      this.provider.idempotencyKey(rawBody),
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
      // Asked of the provider rather than of config: which environment variable makes an instance
      // able to sell is the provider's business, and a second answer to it here would drift.
      available: this.provider.checkoutUrlFor(user.id) !== null,
      subscription,
    };
  }

  /** Where to send somebody who wants to subscribe. The provider decides what that URL is. */
  @Post('checkout')
  @UseGuards(SessionGuard)
  checkout(@CurrentUser() user: CurrentUserPayload) {
    const url = this.provider.checkoutUrlFor(user.id);
    if (!url) throw new BadRequestException('Subscriptions are not available here');
    return { url };
  }
}

/** Express lowercases header names; duplicates arrive joined, which a signature check rejects. */
function header(request: Request, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value.join(', ') : value;
}
