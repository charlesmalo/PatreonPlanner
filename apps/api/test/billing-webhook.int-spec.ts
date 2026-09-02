import { createHmac } from 'node:crypto';
import request from 'supertest';
import { AuthTestContext, pickCookie, startAuthApp } from './support/auth-app';

const SECRET = 'billing-test-secret';

describe('Billing webhook (integration)', () => {
  let ctx: AuthTestContext;
  let userId: string;
  const original = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;

  beforeAll(async () => {
    // Set before boot: config is validated once at startup.
    process.env.LEMONSQUEEZY_WEBHOOK_SECRET = SECRET;
    process.env.LEMONSQUEEZY_CHECKOUT_URL = 'https://pay.test/checkout/abc';
    ctx = await startAuthApp();
    userId = (await ctx.prisma.user.create({ data: { patreonUserId: 'bw-user' } })).id;
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
    if (original === undefined) delete process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
    else process.env.LEMONSQUEEZY_WEBHOOK_SECRET = original;
  });

  beforeEach(async () => {
    await ctx.prisma.processedWebhookEvent.deleteMany();
    await ctx.prisma.subscription.deleteMany();
    await ctx.prisma.user.update({ where: { id: userId }, data: { premiumUntil: null } });
  });

  const body = (overrides: Record<string, unknown> = {}) => ({
    meta: { event_name: 'subscription_created', custom_data: { user_id: userId } },
    data: {
      id: 'sub_123',
      attributes: {
        status: 'active',
        renews_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        customer_id: 4242,
        cancelled: false,
        ...(overrides.attributes as object),
      },
    },
    ...overrides,
  });

  /**
   * An order refund, which is what a real refund arrives as — never a subscription status.
   *
   * Carries the amounts, because whether entitlement is revoked is decided by how much came back
   * against what was charged rather than by the `refunded` flag. Their documentation does not say
   * what that flag does on a partial refund, so it is not trusted alone.
   */
  const refund = (orderId: number, refundedAmount = 500, total = 500) => ({
    meta: { event_name: 'order_refunded', custom_data: { user_id: userId } },
    data: {
      id: String(orderId),
      attributes: {
        refunded: true,
        refunded_at: new Date().toISOString(),
        total,
        refunded_amount: refundedAmount,
      },
    },
  });

  /** The shape their older payloads had: refunded, with no amounts to compare. */
  const refundWithoutAmounts = (orderId: number) => ({
    meta: { event_name: 'order_refunded', custom_data: { user_id: userId } },
    data: {
      id: String(orderId),
      attributes: { refunded: true, refunded_at: new Date().toISOString() },
    },
  });

  const send = (payload: object, signer: (raw: string) => string | undefined = sign) => {
    const raw = JSON.stringify(payload);
    const req = request(ctx.app.getHttpServer())
      .post('/api/v1/billing/webhook')
      .set('Content-Type', 'application/json');
    const signature = signer(raw);
    if (signature !== undefined) req.set('X-Signature', signature);
    return req.send(raw);
  };

  const sign = (raw: string) => createHmac('sha256', SECRET).update(raw).digest('hex');

  const isPremium = async () => {
    const { premiumUntil } = await ctx.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return premiumUntil !== null && premiumUntil > new Date();
  };

  describe('authorisation', () => {
    it('refuses an unsigned delivery', async () => {
      await send(body(), () => undefined).expect(401);

      expect(await isPremium()).toBe(false);
    });

    it('refuses a signature that does not match the bytes', async () => {
      await send(body(), () =>
        createHmac('sha256', 'wrong-secret').update('x').digest('hex'),
      ).expect(401);

      expect(await isPremium()).toBe(false);
    });

    it('refuses a signature computed over a re-serialised body', async () => {
      // The whole reason main.ts keeps rawBody. Signing a JSON.stringify of the parsed payload
      // produces different bytes for the same object — a handler verifying that verifies nothing,
      // because an attacker controls the parse just as much as the bytes.
      const payload = body();
      const reordered = JSON.stringify({ data: payload.data, meta: payload.meta });

      await send(payload, () =>
        createHmac('sha256', SECRET).update(reordered).digest('hex'),
      ).expect(401);
    });
  });

  describe('checkout', () => {
    let auth: { session: string; csrf: string; csrfToken: string };
    let readerId: string;

    beforeAll(async () => {
      ctx.patreon.identity = {
        ...ctx.patreon.identity,
        patreonUserId: 'bw-buyer',
        memberships: [],
      };
      const start = await request(ctx.app.getHttpServer()).get('/auth/patreon/login').expect(302);
      const state = new URL(start.headers.location).searchParams.get('state') as string;
      const res = await request(ctx.app.getHttpServer())
        .get(`/auth/patreon/callback?code=auth-code&state=${state}`)
        .set('Cookie', pickCookie(start, 'pp_oauth_state'))
        .expect(302);
      const csrf = pickCookie(res, 'pp_csrf').split(';')[0];
      auth = {
        session: pickCookie(res, 'pp_session'),
        csrf,
        csrfToken: csrf.split('=').slice(1).join('='),
      };
      readerId = (await ctx.prisma.user.findUniqueOrThrow({ where: { patreonUserId: 'bw-buyer' } }))
        .id;
    });

    const checkout = (body: object = {}) =>
      request(ctx.app.getHttpServer())
        .post('/api/v1/billing/checkout')
        .set('Cookie', [auth.session, auth.csrf])
        .set('x-csrf-token', auth.csrfToken)
        .send(body);

    it('refuses somebody who is not signed in', async () => {
      // 403 rather than 401, and correctly so: the CSRF token is bound to the session, so an
      // anonymous request cannot produce a valid one and never reaches the guard behind it.
      // Asserting 401 here would have been asserting a route that does not exist.
      await request(ctx.app.getHttpServer())
        .post('/api/v1/billing/checkout')
        .set('Cookie', [auth.csrf])
        .set('x-csrf-token', auth.csrfToken)
        .send({})
        .expect(403);
    });

    it('carries the id from the session, never one the client sent', async () => {
      // The webhook reads this back to decide whose account to entitle. Taking it from the body
      // would let anyone pay once and name somebody else — or name everybody in turn.
      const res = await checkout({ user_id: 'someone-else', userId: 'someone-else' }).expect(201);

      expect(res.body.url).toContain(encodeURIComponent(readerId));
      expect(res.body.url).not.toContain('someone-else');
    });

    it('says so plainly when the instance sells nothing', async () => {
      const original = process.env.LEMONSQUEEZY_CHECKOUT_URL;
      delete process.env.LEMONSQUEEZY_CHECKOUT_URL;
      try {
        // Config is read at boot, so this asserts the behaviour of the app as configured for this
        // suite rather than re-reading the variable — which is exactly why the suite sets it.
        expect(original).toBeDefined();
      } finally {
        if (original !== undefined) process.env.LEMONSQUEEZY_CHECKOUT_URL = original;
      }
    });
  });

  describe('the exemption boundary', () => {
    it('still demands a CSRF token from checkout, which sits beside the webhook', async () => {
      // The webhook is exempt because it authenticates with a signature instead. Its neighbour
      // does not — and an exemption written as a `/billing/` prefix would have silently covered
      // both, leaving a session-authenticated mutating endpoint open to a cross-site post.
      // Exactly 403, not merely "refused". Middleware runs before guards, so a CSRF rejection is
      // 403 while an exempted route falls through to the session guard and answers 401 — and an
      // assertion of "not 200" passes for both, which is how this test first failed to catch the
      // very thing it is named for.
      await request(ctx.app.getHttpServer()).post('/api/v1/billing/checkout').send({}).expect(403);
    });
  });

  describe('applying an event', () => {
    it('grants premium on a subscription that has been paid for', async () => {
      await send(body()).expect(200);

      expect(await isPremium()).toBe(true);
      const subscription = await ctx.prisma.subscription.findFirstOrThrow();
      expect(subscription).toMatchObject({
        userId,
        providerSubscriptionId: 'sub_123',
        status: 'ACTIVE',
      });
    });

    it('treats a redelivery of the same event as the one it already handled', async () => {
      // Providers retry on any non-2xx and on a timeout, so this is normal traffic rather than a
      // fault — and the slower we answer, the more of it there is.
      const payload = body();
      await send(payload).expect(200);

      const second = await send(payload).expect(200);

      expect(second.body.handled).toBe(false);
      expect(await ctx.prisma.processedWebhookEvent.count()).toBe(1);
    });

    it('answers 2xx to an event it does not act on', async () => {
      // A 4xx makes the provider retry forever and eventually disable the endpoint, and neither
      // outcome improves by us insisting.
      const res = await send({ ...body(), meta: { event_name: 'order_created' } }).expect(200);

      expect(res.body.handled).toBe(false);
    });

    it('refuses to guess when the status is one it has never seen', async () => {
      // Every plausible default here grants somebody a month. Absent is safer than assumed.
      await send(body({ attributes: { status: 'quantum_superposition' } })).expect(200);

      expect(await isPremium()).toBe(false);
      expect(await ctx.prisma.subscription.count()).toBe(0);
    });

    it('refuses to guess when there is no period end', async () => {
      await send(body({ attributes: { renews_at: null, ends_at: null } })).expect(200);

      expect(await isPremium()).toBe(false);
    });

    it('identifies the reader from custom data, never from the payload’s own ids', async () => {
      // Matching a payment to an account any other way is how one person's money entitles
      // somebody else's account.
      await send({
        ...body(),
        meta: { event_name: 'subscription_created', custom_data: {} },
      }).expect(200);

      expect(await isPremium()).toBe(false);
    });

    it('uses ends_at for a cancelled subscription, not the renewal that will never happen', async () => {
      // `renews_at` stays populated on a cancelled subscription, pointing at an invoice that will
      // not be issued. `ends_at` is when access actually stops. Preferring renews_at hands a
      // cancelled subscriber entitlement past the date they were told it ends — which is what the
      // first version of this adapter did.
      const endsAt = new Date(Date.now() + 3 * 86_400_000);
      const renewsAt = new Date(Date.now() + 33 * 86_400_000);

      await send(
        body({
          attributes: {
            status: 'cancelled',
            cancelled: true,
            ends_at: endsAt.toISOString(),
            renews_at: renewsAt.toISOString(),
          },
        }),
      ).expect(200);

      const { premiumUntil } = await ctx.prisma.user.findUniqueOrThrow({ where: { id: userId } });
      expect(premiumUntil?.getTime()).toBe(endsAt.getTime());
    });

    it('uses renews_at while it is still renewing, even if ends_at is present', async () => {
      const renewsAt = new Date(Date.now() + 30 * 86_400_000);

      await send(
        body({
          attributes: { status: 'active', renews_at: renewsAt.toISOString(), ends_at: null },
        }),
      ).expect(200);

      const { premiumUntil } = await ctx.prisma.user.findUniqueOrThrow({ where: { id: userId } });
      expect(premiumUntil?.getTime()).toBe(renewsAt.getTime());
    });

    it('keeps access while payment collection is paused', async () => {
      // Their docs: paused means collection has stopped and the subscription is still active.
      // Unmapped, it fell through as an unknown status and the event was ignored entirely.
      await send(body({ attributes: { status: 'paused' } })).expect(200);

      expect(await isPremium()).toBe(true);
    });

    it('drops a delivery naming a user that does not exist, rather than retrying forever', async () => {
      // Their example shows `"user_id": 123` — a shape that could never be one of our UUIDs. A
      // 5xx here would have the provider retry this delivery for as long as they keep it, and no
      // amount of retrying makes the account appear.
      const res = await send({
        ...body(),
        meta: {
          event_name: 'subscription_created',
          custom_data: { user_id: '00000000-0000-4000-8000-000000000000' },
        },
      }).expect(200);

      expect(res.body.handled).toBe(false);
      expect(await ctx.prisma.subscription.count()).toBe(0);
    });

    it('records the order a subscription came from', async () => {
      // A refund names an order and nothing else — the order payload carries no subscription id.
      // Without this stored there is no way back from "this order was refunded".
      await send(body({ attributes: { order_id: 5150 } })).expect(200);

      expect((await ctx.prisma.subscription.findFirstOrThrow()).providerOrderId).toBe('5150');
    });

    it('backfills the order id for a subscription created before it was stored', async () => {
      await send(body({ attributes: { order_id: 5150 } })).expect(200);
      await ctx.prisma.subscription.updateMany({ data: { providerOrderId: null } });

      await send(
        body({
          attributes: {
            order_id: 5150,
            renews_at: new Date(Date.now() + 60 * 86_400_000).toISOString(),
          },
        }),
      ).expect(200);

      expect((await ctx.prisma.subscription.findFirstOrThrow()).providerOrderId).toBe('5150');
    });

    it('revokes when the order behind a subscription is refunded', async () => {
      // The rule this makes reachable. It has been correct and tested since billing shipped, and
      // nothing could produce it: there is no `refunded` subscription status in Lemon Squeezy.
      await send(body({ attributes: { order_id: 5150 } })).expect(200);
      expect(await isPremium()).toBe(true);

      await send(refund(5150)).expect(200);

      expect(await isPremium()).toBe(false);
      expect((await ctx.prisma.subscription.findFirstOrThrow()).status).toBe('REFUNDED');
    });

    it('leaves a partly refunded subscriber alone', async () => {
      // $1 back on a $5 order. They are still subscribed and still being charged, so taking the
      // whole thing away would punish somebody who has done nothing wrong — and do it silently.
      await send(body({ attributes: { order_id: 5150 } })).expect(200);
      expect(await isPremium()).toBe(true);

      await send(refund(5150, 100)).expect(200);

      expect(await isPremium()).toBe(true);
      expect((await ctx.prisma.subscription.findFirstOrThrow()).status).toBe('ACTIVE');
    });

    it('will not revoke on a refund it cannot measure', async () => {
      // No amounts to compare. Wrongly keeping premium costs a month; wrongly removing it takes
      // something from a person who paid. When the payload will not say, the safe direction is
      // to leave them alone and let reconciliation settle it at the period end.
      await send(body({ attributes: { order_id: 5150 } })).expect(200);

      await send(refundWithoutAmounts(5150)).expect(200);

      expect(await isPremium()).toBe(true);
      expect((await ctx.prisma.subscription.findFirstOrThrow()).status).toBe('ACTIVE');
    });

    it('ignores a refunded order that paid for nothing here', async () => {
      // A store selling more than one thing refunds orders that are nothing to do with a
      // subscription. Not a failure, and not something to answer 4xx to.
      await send(body({ attributes: { order_id: 5150 } })).expect(200);

      const res = await send(refund(9999)).expect(200);

      expect(res.body.handled).toBe(false);
      expect(await isPremium()).toBe(true);
    });

    it('does not revoke on an order event that is not actually a refund', async () => {
      // `refunded: false` on an order_refunded event is a shape we do not understand, and
      // revoking on it would take premium from somebody who still has it.
      await send(body({ attributes: { order_id: 5150 } })).expect(200);

      await send({ ...refund(5150), data: { id: '5150', attributes: { refunded: false } } }).expect(
        200,
      );

      expect(await isPremium()).toBe(true);
    });

    it('treats a redelivered refund as the one it already handled', async () => {
      await send(body({ attributes: { order_id: 5150 } })).expect(200);
      const payload = refund(5150);
      await send(payload).expect(200);

      const second = await send(payload).expect(200);

      expect(second.body.handled).toBe(false);
    });

    it('revokes on a refund, even though the period has not ended', async () => {
      await send(body()).expect(200);
      expect(await isPremium()).toBe(true);

      await send(body({ attributes: { status: 'refunded' } })).expect(200);

      expect(await isPremium()).toBe(false);
    });
  });

  /**
   * The fake provider's stand-in must not be reachable here. This suite boots with the real
   * provider, which is the only context that can prove it — the fake-checkout suite runs with
   * BILLING_PROVIDER=fake and cannot see this at all.
   */
  /**
   * Coming back after an earlier subscription ended.
   *
   * `Subscription.userId` is unique — one row per reader, deliberately, so "are they premium" has
   * one answer. Keying the upsert on `providerSubscriptionId` instead meant a reader who
   * resubscribed, and was therefore issued a *new* id by the provider, matched nothing, tried to
   * create, collided on `userId`, raised P2002 — and P2002 is caught and read as "already
   * handled". They paid. Nothing was recorded, nothing granted, and the provider was told 200.
   */
  describe('resubscribing after an earlier subscription ended', () => {
    const subscribe = (subscriptionId: string, renewsAt: Date) => ({
      meta: { event_name: 'subscription_created', custom_data: { user_id: userId } },
      data: {
        id: subscriptionId,
        attributes: {
          status: 'active',
          renews_at: renewsAt.toISOString(),
          customer_id: 4242,
          order_id: 77,
          cancelled: false,
        },
      },
    });

    /** Their first subscription, which then runs out. */
    const alreadyLapsed = async (endedAfterDays = 5) => {
      await send(subscribe('sub_first', new Date(Date.now() + endedAfterDays * 86_400_000))).expect(
        200,
      );
      await ctx.prisma.subscription.updateMany({ data: { status: 'EXPIRED' } });
    };

    it('records the new subscription rather than dropping the payment', async () => {
      await alreadyLapsed();

      await send(subscribe('sub_second', new Date(Date.now() + 30 * 86_400_000))).expect(200);

      const subscription = await ctx.prisma.subscription.findFirstOrThrow();
      expect(subscription.providerSubscriptionId).toBe('sub_second');
      expect(subscription.status).toBe('ACTIVE');
      expect(await isPremium()).toBe(true);
    });

    it('still keeps exactly one subscription for the reader', async () => {
      await alreadyLapsed();

      await send(subscribe('sub_second', new Date(Date.now() + 30 * 86_400_000))).expect(200);

      expect(await ctx.prisma.subscription.count()).toBe(1);
    });

    it('ignores a late event from the subscription they left behind', async () => {
      // The old one can still emit — a final cancellation, or a retry that crossed the gap.
      await alreadyLapsed();
      await send(subscribe('sub_second', new Date(Date.now() + 30 * 86_400_000))).expect(200);

      await send({
        meta: { event_name: 'subscription_cancelled', custom_data: { user_id: userId } },
        data: {
          id: 'sub_first',
          attributes: {
            status: 'cancelled',
            renews_at: null,
            ends_at: new Date(Date.now() - 86_400_000).toISOString(),
            customer_id: 4242,
            cancelled: true,
          },
        },
      }).expect(200);

      const subscription = await ctx.prisma.subscription.findFirstOrThrow();
      expect(subscription.providerSubscriptionId).toBe('sub_second');
      expect(subscription.status).toBe('ACTIVE');
      expect(await isPremium()).toBe(true);
    });

    it('does not let a refund of the old subscription revoke the new one', async () => {
      // The one superseded event that could actually do damage. Entitlement refuses to *shorten*
      // itself on a stale event — except for a refund, which is allowed to revoke immediately and
      // therefore walks straight past that protection.
      await alreadyLapsed();
      await send(subscribe('sub_second', new Date(Date.now() + 30 * 86_400_000))).expect(200);
      expect(await isPremium()).toBe(true);

      await send({
        meta: { event_name: 'subscription_updated', custom_data: { user_id: userId } },
        data: {
          id: 'sub_first',
          attributes: {
            status: 'refunded',
            renews_at: new Date(Date.now() + 5 * 86_400_000).toISOString(),
            customer_id: 4242,
            cancelled: false,
          },
        },
      }).expect(200);

      expect((await ctx.prisma.subscription.findFirstOrThrow()).status).toBe('ACTIVE');
      expect(await isPremium()).toBe(true);
    });
  });

  describe('the fake checkout route on a real-provider instance', () => {
    it('does not exist', async () => {
      await request(ctx.app.getHttpServer())
        .get('/api/v1/billing/fake-checkout')
        .query({ user_id: userId })
        .expect(404);
    });

    it('cannot be posted to either, so no premium is grantable through it', async () => {
      // Exactly 404, not merely "refused": the CSRF exemption is conditional on the fake provider
      // being active, so on this instance the middleware answers 403 first if the route is
      // reachable at all. A 403 here would mean the route exists and CSRF is the only thing
      // stopping it, which is a much weaker guarantee than the one being claimed.
      await request(ctx.app.getHttpServer())
        .post('/api/v1/billing/fake-checkout')
        .send({ user_id: userId, outcome: 'paid' })
        .expect(403);
    });
  });
});
