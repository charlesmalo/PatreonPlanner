import { SubscriptionStatus } from '@prisma/client';

/**
 * The seam every payment provider sits behind.
 *
 * Nothing in this file names a provider, and nothing outside `billing/` names one at all. The
 * point is not elegance: it is that switching providers, or standing a fake one up for a demo,
 * should be a config value and one new file rather than a search across the codebase.
 *
 * Two implementations exist — `LemonSqueezyAdapter`, which takes real money, and
 * `FakePaymentProvider`, which takes none. They deliberately share no wire format, so a provider
 * assumption that leaked through this interface would break one of them. `payment-provider-conformance`
 * runs the same contract against both.
 */

export interface SubscriptionEvent {
  eventType: string;
  userId: string;
  providerSubscriptionId: string;
  providerCustomerId: string;
  /** The order that created it — the only way back here from a refund. Absent on older rows. */
  providerOrderId: string | null;
  status: SubscriptionStatus;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  /**
   * What was actually charged, when the payload says. Absent on events that move a subscription
   * without taking money — a cancellation, a reconciliation read — and a receipt is written only
   * when it is present, so nothing invents a payment that did not happen.
   */
  payment?: PaymentDetails;
}

/**
 * A charge, in the only terms this application keeps.
 *
 * No name, no email, no address, no card brand, no last four. A merchant of record holds all of
 * that, and holding a second copy here would turn a demo database into somebody's billing record.
 */
export interface PaymentDetails {
  /** The provider's own reference for the charge — what makes a receipt idempotent. */
  providerReceiptId: string;
  amountCents: number;
  /** ISO-4217. */
  currency: string;
  paidAt: Date;
  /** Where the provider hosts the real receipt, if it hosts one. */
  url: string | null;
}

/** A refund. Separate from a subscription event because it names an order and nothing else. */
export interface RefundEvent {
  eventType: string;
  providerOrderId: string;
  /**
   * Whether the whole order came back, rather than part of it.
   *
   * Entitlement is all-or-nothing here — there is no half a month of premium — so only a full
   * refund revokes. A partial one is recorded as seen and changes nothing.
   *
   * The provider must establish this positively. When it cannot tell, this is **false**: wrongly
   * keeping premium costs a month, while wrongly removing it punishes somebody who paid and holds
   * a subscription they are still being charged for.
   */
  isFull: boolean;
}

export interface PaymentProvider {
  /** Stored on every row this provider writes, so a swap leaves an audit trail rather than a mystery. */
  readonly provider: string;

  /**
   * Where to send somebody who wants to subscribe, or null when this instance cannot sell.
   *
   * Null rather than a throw: an instance with no payment provider configured is an ordinary,
   * supported state, and the page that asks needs an answer rather than an exception.
   */
  checkoutUrlFor(userId: string): string | null;

  /**
   * The secret `verify` should be given, or undefined when none is configured.
   *
   * On the port rather than read from config by the caller: the webhook route knowing the name of
   * a provider's environment variable is exactly the coupling this interface exists to remove.
   * Undefined means the endpoint must refuse — with no secret there is no way to tell a real
   * delivery from anybody's POST.
   */
  signingSecret(): string | undefined;

  /** Over the exact bytes that arrived, never a re-serialised body. */
  verify(rawBody: Buffer, signature: string | undefined, secret: string): boolean;

  /** A stable key for "have we already handled this delivery". */
  idempotencyKey(rawBody: Buffer): string;

  /**
   * Their payload to ours, or null for anything we do not act on or do not recognise.
   *
   * Null rather than a guess, and never a default: every plausible default here grants somebody a
   * month they did not pay for.
   */
  parse(body: unknown): SubscriptionEvent | null;

  /** A refunded order, or null. Separate because a refund names an order, not a subscription. */
  parseRefund(body: unknown): RefundEvent | null;

  /**
   * Asks the provider what a subscription is really doing.
   *
   * Null means "could not answer", which the caller must treat as unknown and never as cancelled.
   */
  fetchSubscription(providerSubscriptionId: string): Promise<SubscriptionEvent | null>;
}

/**
 * A symbol rather than a string: two providers registered under the same string token collide
 * silently, and the one that wins is whichever module was imported last.
 */
export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');
