import { createHmac } from 'node:crypto';
import request from 'supertest';
import { AuthTestContext, startAuthApp } from './support/auth-app';

const SECRET = 'billing-test-secret';

describe('Billing webhook (integration)', () => {
  let ctx: AuthTestContext;
  let userId: string;
  const original = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;

  beforeAll(async () => {
    // Set before boot: config is validated once at startup.
    process.env.LEMONSQUEEZY_WEBHOOK_SECRET = SECRET;
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

    it('revokes on a refund, even though the period has not ended', async () => {
      await send(body()).expect(200);
      expect(await isPremium()).toBe(true);

      await send(body({ attributes: { status: 'refunded' } })).expect(200);

      expect(await isPremium()).toBe(false);
    });
  });
});
