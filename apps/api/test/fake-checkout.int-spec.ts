import request from 'supertest';
import { AuthTestContext, startAuthApp } from './support/auth-app';

/**
 * The fake provider's checkout stand-in, end to end.
 *
 * The point of these is not that a button works. It is that pressing it drives the *real* path —
 * signature verification, the idempotency key, the parse, the subscription upsert and the
 * entitlement projection — so a demo purchase proves the code a real purchase will run, rather
 * than proving a shortcut around it.
 */
describe('Fake checkout (integration)', () => {
  let ctx: AuthTestContext;
  let userId: string;
  const previous = {
    provider: process.env.BILLING_PROVIDER,
    env: process.env.NODE_ENV,
  };

  beforeAll(async () => {
    // Set before boot: config is validated once at startup.
    process.env.BILLING_PROVIDER = 'fake';
    ctx = await startAuthApp();
    userId = (await ctx.prisma.user.create({ data: { patreonUserId: 'fc-user' } })).id;
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
    // Restored rather than left set: a suite that grants state and does not take it back passes
    // on a fresh run and fails on every one after.
    if (previous.provider === undefined) delete process.env.BILLING_PROVIDER;
    else process.env.BILLING_PROVIDER = previous.provider;
    if (previous.env === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous.env;
  });

  beforeEach(async () => {
    await ctx.prisma.processedWebhookEvent.deleteMany();
    await ctx.prisma.subscription.deleteMany();
    await ctx.prisma.user.update({ where: { id: userId }, data: { premiumUntil: null } });
  });

  const server = () => request(ctx.app.getHttpServer());
  const act = (outcome: string, user = userId) =>
    server().post('/api/v1/billing/fake-checkout').send({ user_id: user, outcome });

  const premiumUntil = async () =>
    (await ctx.prisma.user.findUniqueOrThrow({ where: { id: userId } })).premiumUntil;

  describe('the page itself', () => {
    it('renders a checkout the reader can act on', async () => {
      const response = await server()
        .get('/api/v1/billing/fake-checkout')
        .query({ user_id: userId })
        .expect(200);

      expect(response.headers['content-type']).toMatch(/text\/html/);
      expect(response.text).toContain('outcome');
    });

    it('says plainly that no money is involved', async () => {
      // A demo page that looks like a real payment form is a page somebody will eventually put a
      // real card number into.
      const response = await server()
        .get('/api/v1/billing/fake-checkout')
        .query({ user_id: userId })
        .expect(200);

      expect(response.text).toMatch(/no (real )?money|not a real|no card/i);
    });

    it('carries no script, so nothing about it can be a supply chain', async () => {
      const response = await server()
        .get('/api/v1/billing/fake-checkout')
        .query({ user_id: userId })
        .expect(200);

      expect(response.text).not.toMatch(/<script|src=["']http/i);
    });
  });

  describe('paying', () => {
    it('grants premium that runs into the future', async () => {
      await act('paid').expect(302);

      const until = await premiumUntil();
      expect(until).not.toBeNull();
      expect(until!.getTime()).toBeGreaterThan(Date.now());
    });

    it('writes exactly one subscription, marked as this provider', async () => {
      await act('paid').expect(302);

      const subscriptions = await ctx.prisma.subscription.findMany();
      expect(subscriptions).toHaveLength(1);
      expect(subscriptions[0]).toMatchObject({ provider: 'fake', status: 'ACTIVE', userId });
    });

    it('sends the reader back to the app rather than leaving them on the stand-in', async () => {
      const response = await act('paid').expect(302);

      expect(response.headers.location).toMatch(/\/premium/);
    });

    it('really did go through signature verification', async () => {
      // The evidence: a ProcessedWebhookEvent row only exists if ingest ran to completion, and
      // ingest refuses before that point when a signature does not verify.
      await act('paid').expect(302);

      const processed = await ctx.prisma.processedWebhookEvent.findMany();
      expect(processed).toHaveLength(1);
      expect(processed[0].provider).toBe('fake');
    });
  });

  describe('the unhappy paths', () => {
    it('grants nothing when the payment is declined', async () => {
      await act('declined').expect(302);

      expect(await premiumUntil()).toBeNull();
      expect(await ctx.prisma.subscription.count()).toBe(0);
    });

    it('keeps access through the grace window when a renewal fails', async () => {
      await act('paid').expect(302);
      await act('past_due').expect(302);

      const subscription = await ctx.prisma.subscription.findFirstOrThrow();
      expect(subscription.status).toBe('PAST_DUE');
      // Still entitled: the five-day grace window is the whole reason PAST_DUE is not EXPIRED.
      const until = await premiumUntil();
      expect(until!.getTime()).toBeGreaterThan(Date.now());
    });

    it('revokes immediately on a refund, with no grace', async () => {
      await act('paid').expect(302);
      await act('refunded').expect(302);

      expect((await ctx.prisma.subscription.findFirstOrThrow()).status).toBe('REFUNDED');
      // A grace window on a refund is a window for buying premium and taking the money back.
      expect(await premiumUntil()).toBeNull();
    });

    it('leaves access in place until the period ends when they cancel', async () => {
      await act('paid').expect(302);
      await act('cancelled').expect(302);

      const subscription = await ctx.prisma.subscription.findFirstOrThrow();
      expect(subscription.status).toBe('CANCELLED');
      expect(subscription.cancelAtPeriodEnd).toBe(true);
      // They paid for the month. Cancelling is not a refund.
      expect((await premiumUntil())!.getTime()).toBeGreaterThan(Date.now());
    });

    it('refuses an outcome it does not know rather than guessing one', async () => {
      await act('free_premium_please').expect(400);

      expect(await premiumUntil()).toBeNull();
    });

    it('drops a purchase for a user that does not exist, without granting anything', async () => {
      await act('paid', '00000000-0000-4000-8000-000000000000').expect(302);

      expect(await ctx.prisma.subscription.count()).toBe(0);
    });

    it('refuses a user id that is not a user id', async () => {
      await act('paid', 'not-a-uuid').expect(400);
    });
  });

  describe('replaying', () => {
    it('does not stack two subscriptions when the same purchase is repeated', async () => {
      await act('paid').expect(302);
      await act('paid').expect(302);

      expect(await ctx.prisma.subscription.count()).toBe(1);
    });
  });
});
