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
import { ReceiptService } from './receipt.service';
import { WebhookIngestService } from './webhook-ingest.service';

@Controller('billing')
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly ingest: WebhookIngestService,
    private readonly receipts: ReceiptService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  /**
   * Where the provider tells us what happened.
   *
   * Unauthenticated by design — the provider has no session — and therefore authorised entirely
   * by the signature over the raw bytes. Everything downstream trusts this endpoint, so it is the
   * one place in the application where getting verification wrong hands out entitlement.
   *
   * The work is in `WebhookIngestService`, shared with the fake provider's checkout stand-in. All
   * this does is turn its reasons back into HTTP.
   */
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  async webhook(@Req() request: Request & { rawBody?: Buffer }) {
    const result = await this.ingest.ingest(
      request.rawBody,
      header(request, 'x-signature'),
      request.body,
    );

    if (!result.ok) {
      if (result.reason === 'no-body') throw new BadRequestException();
      throw new UnauthorizedException();
    }
    return { ok: true, handled: result.handled };
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
      // Whether this instance is running the provider that takes no money. The page uses it to
      // label itself honestly and to offer the outcomes a real provider would never let anybody
      // choose — refunding your own subscription, failing your own renewal.
      //
      // Sent rather than inferred from the checkout URL: what that URL looks like is the
      // provider's business, and a client matching on it would be a second, drifting answer to
      // "is this real money".
      sandbox: this.provider.provider === 'fake',
      subscription,
    };
  }

  /**
   * This reader's payment history.
   *
   * Their own only, scoped by the session rather than by anything the caller sends — a receipts
   * endpoint that takes a user id is a receipts endpoint that reads somebody else's.
   */
  @Get('receipts')
  @UseGuards(SessionGuard)
  async receiptsFor(@CurrentUser() user: CurrentUserPayload) {
    return { receipts: await this.receipts.forUser(user.id) };
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
