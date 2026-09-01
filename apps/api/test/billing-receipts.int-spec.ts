import request from 'supertest';
import { ReceiptService } from '../src/billing/receipt.service';
import { AuthTestContext, pickCookie, startAuthApp } from './support/auth-app';

/**
 * Receipts: what an account paid, and nothing about who they are.
 *
 * The privacy assertions here are the point of the model as much as the behaviour is. A merchant
 * of record holds the name, the address and the card; a second copy in this database would turn a
 * demo into somebody's billing record.
 */
describe('Payment receipts (integration)', () => {
  let ctx: AuthTestContext;
  let userId: string;
  const previous = process.env.BILLING_PROVIDER;

  beforeAll(async () => {
    process.env.BILLING_PROVIDER = 'fake';
    ctx = await startAuthApp();
    userId = (await ctx.prisma.user.create({ data: { patreonUserId: 'rc-user' } })).id;
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
    if (previous === undefined) delete process.env.BILLING_PROVIDER;
    else process.env.BILLING_PROVIDER = previous;
  });

  beforeEach(async () => {
    await ctx.prisma.paymentReceipt.deleteMany();
    await ctx.prisma.processedWebhookEvent.deleteMany();
    await ctx.prisma.subscription.deleteMany();
    await ctx.prisma.user.update({ where: { id: userId }, data: { premiumUntil: null } });
  });

  const server = () => request(ctx.app.getHttpServer());
  const buy = (user = userId) =>
    server().post('/api/v1/billing/fake-checkout').send({ user_id: user, outcome: 'paid' });

  it('writes one receipt for one payment', async () => {
    await buy().expect(302);

    const receipts = await ctx.prisma.paymentReceipt.findMany();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      userId,
      provider: 'fake',
      amountCents: 500,
      currency: 'USD',
    });
  });

  it('holds no trace of who the person is', async () => {
    await buy().expect(302);

    const receipt = await ctx.prisma.paymentReceipt.findFirstOrThrow();
    const columns = Object.keys(receipt);
    // Named individually rather than eyeballed: this is the constraint the whole model exists to
    // keep, and a column added later that breaks it should fail here.
    for (const forbidden of ['name', 'email', 'address', 'cardBrand', 'cardLast4', 'lastFour']) {
      expect(columns).not.toContain(forbidden);
    }
    expect(JSON.stringify(receipt)).not.toMatch(/@/);
  });

  it('writes nothing for a move that took no money', async () => {
    // Cancelling is not a payment. A receipt for it would put a charge in somebody's history
    // that never happened.
    await server()
      .post('/api/v1/billing/fake-checkout')
      .send({ user_id: userId, outcome: 'cancelled' })
      .expect(302);

    expect(await ctx.prisma.paymentReceipt.count()).toBe(0);
  });

  it('writes nothing when the card is declined', async () => {
    await server()
      .post('/api/v1/billing/fake-checkout')
      .send({ user_id: userId, outcome: 'declined' })
      .expect(302);

    expect(await ctx.prisma.paymentReceipt.count()).toBe(0);
  });

  it('records one charge once, even when two different events carry it', async () => {
    // Not reachable through the stand-in: two identical payloads are already dropped upstream by
    // the idempotency key, so this is the case that survives it — a creation and a
    // payment-succeeded naming the same charge, which is an ordinary pair for a real provider.
    //
    // The unique index is what makes it a no-op. Without skipDuplicates it raises inside the
    // transaction and takes the subscription write down with it.
    const receipts = ctx.app.get(ReceiptService);
    const charge = {
      providerReceiptId: 'rcp_same',
      amountCents: 500,
      currency: 'USD',
      paidAt: new Date(),
      url: null,
    };

    await ctx.prisma.$transaction((tx) => receipts.record(tx, 'fake', userId, 'ord_1', charge));
    await expect(
      ctx.prisma.$transaction((tx) => receipts.record(tx, 'fake', userId, 'ord_1', charge)),
    ).resolves.not.toThrow();

    expect(await ctx.prisma.paymentReceipt.count()).toBe(1);
  });

  describe('the endpoint', () => {
    /** The real OAuth round trip, which is how every other suite here obtains a session. */
    const signIn = async (patreonUserId = 'rc-user') => {
      ctx.patreon.identity = { ...ctx.patreon.identity, patreonUserId, memberships: [] };
      const start = await server().get('/auth/patreon/login').expect(302);
      const state = new URL(start.headers.location).searchParams.get('state') as string;
      const res = await server()
        .get(`/auth/patreon/callback?code=auth-code&state=${state}`)
        .set('Cookie', pickCookie(start, 'pp_oauth_state'))
        .expect(302);
      return [pickCookie(res, 'pp_session'), pickCookie(res, 'pp_csrf').split(';')[0]];
    };

    it('returns the caller their own receipts', async () => {
      await buy().expect(302);
      const cookies = await signIn();

      const response = await server()
        .get('/api/v1/billing/receipts')
        .set('Cookie', cookies)
        .expect(200);

      expect(response.body.receipts).toHaveLength(1);
      expect(response.body.receipts[0]).toMatchObject({ amountCents: 500, currency: 'USD' });
    });

    it('never returns somebody else’s', async () => {
      const other = await ctx.prisma.user.create({ data: { patreonUserId: 'rc-other' } });
      await buy(other.id).expect(302);
      const cookies = await signIn();

      const response = await server()
        .get('/api/v1/billing/receipts')
        .set('Cookie', cookies)
        .expect(200);

      expect(response.body.receipts).toHaveLength(0);
    });

    it('refuses a caller with no session', async () => {
      await server().get('/api/v1/billing/receipts').expect(401);
    });
  });
});
