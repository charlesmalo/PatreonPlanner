import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Inject,
  NotFoundException,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { IsIn, IsUUID } from 'class-validator';
import type { Response } from 'express';
import { createHmac } from 'node:crypto';
import { ConfigService } from '../../config/config.module';
import { PAYMENT_PROVIDER, type PaymentProvider } from '../payment-provider';
import { WebhookIngestService } from '../webhook-ingest.service';

/** What the demo can make happen. Each is a state a real subscription genuinely reaches. */
const OUTCOMES = ['paid', 'declined', 'past_due', 'cancelled', 'refunded'] as const;
type Outcome = (typeof OUTCOMES)[number];

export class FakeCheckoutDto {
  // A real checkout carries the reader id as opaque custom data and this does the same. It is
  // never trusted: the webhook path re-checks that the user exists, and drops the event if not.
  @IsUUID()
  user_id!: string;

  @IsIn(OUTCOMES as unknown as string[])
  outcome!: Outcome;
}

/**
 * The fake provider's hosted checkout, standing in for a page on somebody else's domain.
 *
 * Pressing a button here does not grant anything directly. It builds a payload in the fake
 * provider's dialect, signs it, and hands it to the same `WebhookIngestService` a real delivery
 * goes through — so a demo purchase runs signature verification, the idempotency key, the parse,
 * the subscription upsert and the entitlement projection. Granting entitlement directly would
 * have demonstrated the outcome while skipping every line that has ever held a bug.
 *
 * Mounted unconditionally and refusing at the door when the fake provider is not the one running,
 * rather than registered conditionally: a route that answers 404 with a reason is far easier to
 * diagnose than a route that does not exist.
 */
@Controller('billing')
export class FakeCheckoutController {
  constructor(
    private readonly ingest: WebhookIngestService,
    private readonly config: ConfigService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  @Get('fake-checkout')
  @Header('Content-Type', 'text/html; charset=utf-8')
  page(@Query('user_id') userId?: string): string {
    this.onlyWhenFake();
    // Not validated as a UUID here on purpose: this renders a page, and the POST is where the id
    // has to hold up. A 400 on the page would be a worse demo than a form that then refuses.
    return checkoutPage(userId ?? '');
  }

  @Post('fake-checkout')
  async act(@Body() dto: FakeCheckoutDto, @Res() response: Response): Promise<void> {
    this.onlyWhenFake();

    // A declined card never reaches the merchant's webhook at all — nothing happened, so nothing
    // is recorded. Modelling it as an event would invent a subscription for a payment that failed.
    if (dto.outcome !== 'declined') {
      const body = payloadFor(dto.user_id, dto.outcome);
      const rawBody = Buffer.from(JSON.stringify(body));
      const secret = this.provider.signingSecret();
      const signature = secret
        ? createHmac('sha256', secret).update(rawBody).digest('hex')
        : undefined;

      // Deliberately through ingest rather than around it. If the signature is wrong the demo
      // purchase fails, exactly as a real one would — which is the only way this proves anything.
      await this.ingest.ingest(rawBody, signature, body);
    }

    const back = new URL('/premium', this.config.get('WEB_ORIGIN'));
    back.searchParams.set('checkout', dto.outcome);
    response.redirect(302, back.toString());
  }

  /** The route exists on every instance; it works only where the fake provider is the one running. */
  private onlyWhenFake(): void {
    if (this.provider.provider !== 'fake') {
      throw new NotFoundException('This instance does not run the fake payment provider');
    }
  }
}

/**
 * A payload in the fake provider's dialect.
 *
 * The subscription and order ids are derived from the reader so that paying and then refunding
 * refer to the same thing — a refund names an order and nothing else, and without a stable order
 * id there would be no way back from one to the subscription it paid for.
 */
function payloadFor(
  userId: string,
  outcome: Exclude<Outcome, 'declined'>,
): Record<string, unknown> {
  const order = `fake_ord_${userId}`;
  if (outcome === 'refunded') return { kind: 'order.refunded', order };

  const seconds = Math.floor(Date.now() / 1000);
  const base = {
    sub: `fake_sub_${userId}`,
    buyer: userId,
    customer: `fake_cus_${userId}`,
    order,
    period_ends: seconds + 30 * 86_400,
  };

  if (outcome === 'past_due') {
    return { ...base, kind: 'subscription.payment_failed', state: 'dunning', will_renew: true };
  }
  if (outcome === 'cancelled') {
    // Still paid for: access runs to the period end, which is what cancelAtPeriodEnd means.
    return { ...base, kind: 'subscription.cancelled', state: 'stopping', will_renew: false };
  }
  return {
    ...base,
    kind: 'subscription.activated',
    state: 'live',
    will_renew: true,
    paid: {
      cents: 500,
      currency: 'USD',
      // Unique per charge, as a real receipt reference is — two payments are two receipts.
      receipt: `fake_rcp_${userId}_${seconds}`,
      at: seconds,
    },
  };
}

/**
 * The stand-in page. No script, no external asset, nothing to fetch — it is served by the API and
 * must not become a thing that loads code from anywhere.
 *
 * It is styled to look obviously unlike a payment form. A convincing one is a page somebody
 * eventually types a real card number into.
 */
function checkoutPage(userId: string): string {
  const buttons = OUTCOMES.map(
    (outcome) =>
      `<button name="outcome" value="${outcome}" type="submit">${LABELS[outcome]}</button>`,
  ).join('\n      ');

  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Fake checkout</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 34rem; margin: 3rem auto; padding: 0 1rem; }
  .banner { background: #fef3c7; border: 2px dashed #b45309; color: #7c2d12; padding: 1rem; }
  button { display: block; width: 100%; margin: .5rem 0; padding: .6rem; font: inherit; cursor: pointer; }
</style>
</head>
<body>
  <p class="banner"><strong>This is not a real checkout.</strong> No money is taken, no card is
  asked for, and nothing here is a real transaction. It stands in for the payment provider's own
  page so the rest of the product can be demonstrated.</p>
  <h1>Premium — $5.00 / month</h1>
  <form method="post" action="fake-checkout">
    <input type="hidden" name="user_id" value="${escapeHtml(userId)}">
      ${buttons}
  </form>
</body>
</html>`;
}

const LABELS: Record<Outcome, string> = {
  paid: 'Pay $5.00 (succeeds)',
  declined: 'Card declined',
  past_due: 'Pay, then let the renewal fail',
  cancelled: 'Pay, then cancel',
  refunded: 'Refund the last order',
};

/** The id is echoed into the markup, and it arrives from the query string. */
function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ??
      character,
  );
}
