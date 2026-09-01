import { Inject, Injectable } from '@nestjs/common';
import { BillingService } from './billing.service';
import { PAYMENT_PROVIDER, type PaymentProvider } from './payment-provider';

/**
 * Why a delivery was not acted on. `handled: false` is an ordinary outcome — a redelivery, an
 * event type we ignore, a shape we do not recognise — and the endpoint answers 2xx to all of it.
 */
export type IngestResult =
  | { ok: true; handled: boolean }
  | { ok: false; reason: 'unsigned' | 'no-body' | 'unverified' };

/**
 * The one path from signed bytes to entitlement.
 *
 * It exists because there are now two callers — the webhook route, which receives real deliveries,
 * and the fake provider's checkout stand-in, which manufactures them for a demo. Had the stand-in
 * called `BillingService` directly it would have demonstrated a purchase while skipping signature
 * verification, idempotency and the parse, which is precisely the code that has held every billing
 * bug found so far. Sharing this method means the demo exercises the real thing.
 *
 * Returns a reason rather than throwing, because one of those two callers renders a page and an
 * exception thrown three layers down is not something a page can render. The HTTP route turns the
 * reasons back into the statuses it has always returned.
 */
@Injectable()
export class WebhookIngestService {
  constructor(
    private readonly billing: BillingService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  async ingest(
    rawBody: Buffer | undefined,
    signature: string | undefined,
    body: unknown,
  ): Promise<IngestResult> {
    const secret = this.provider.signingSecret();
    // No secret means no way to tell a real delivery from anybody's POST. Refusing is the only
    // safe answer; an instance that does not sell anything has no webhooks to receive.
    if (!secret) return { ok: false, reason: 'unsigned' };
    if (!rawBody) return { ok: false, reason: 'no-body' };
    if (!this.provider.verify(rawBody, signature, secret)) {
      return { ok: false, reason: 'unverified' };
    }

    const idempotencyKey = this.provider.idempotencyKey(rawBody);

    // Refunds first: they are an order event, and the subscription parse would reject one anyway.
    const refund = this.provider.parseRefund(body);
    if (refund) {
      const applied = await this.billing.applyRefund(
        this.provider.provider,
        idempotencyKey,
        refund,
      );
      return { ok: true, handled: applied };
    }

    const event = this.provider.parse(body);
    // Something we do not act on, or a shape we do not recognise. Answered 2xx by the caller
    // deliberately: a 4xx makes the provider retry it forever and eventually disable the
    // endpoint, and neither outcome is improved by us insisting.
    if (!event) return { ok: true, handled: false };

    const applied = await this.billing.applyEvent(this.provider.provider, idempotencyKey, event);
    return { ok: true, handled: applied };
  }
}
