import request from 'supertest';
import { AuthTestContext, pickCookie, startAuthApp } from './support/auth-app';

/**
 * Reading a balance.
 *
 * Two properties this file defends: a balance is **private** — asking for somebody else's is
 * refused as though they did not exist — and reading one **grants** any period due first, which
 * is the whole of the lazy-granting design.
 */
describe('Token balance (integration)', () => {
  let ctx: AuthTestContext;
  let creatorId: string;
  let tierId: string;
  let reader: Auth;
  let other: Auth;

  type Auth = { session: string; csrf: string; csrfToken: string; userId: string };

  beforeAll(async () => {
    ctx = await startAuthApp();
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
  });

  async function loginAs(patreonUserId: string): Promise<Auth> {
    ctx.patreon.identity = { ...ctx.patreon.identity, patreonUserId, memberships: [] };
    const start = await request(ctx.app.getHttpServer()).get('/auth/patreon/login').expect(302);
    const state = new URL(start.headers.location).searchParams.get('state') as string;
    const res = await request(ctx.app.getHttpServer())
      .get(`/auth/patreon/callback?code=auth-code&state=${state}`)
      .set('Cookie', pickCookie(start, 'pp_oauth_state'))
      .expect(302);
    const csrf = pickCookie(res, 'pp_csrf').split(';')[0];
    const user = await ctx.prisma.user.findFirstOrThrow({ where: { patreonUserId } });
    return {
      session: pickCookie(res, 'pp_session'),
      csrf,
      csrfToken: csrf.split('=').slice(1).join('='),
      userId: user.id,
    };
  }

  beforeEach(async () => {
    await ctx.prisma.tokenLedger.deleteMany();
    await ctx.prisma.tokenBalance.deleteMany();
    await ctx.prisma.membership.deleteMany();
    await ctx.prisma.tier.deleteMany();
    await ctx.prisma.creatorPolicy.deleteMany();
    await ctx.prisma.creator.deleteMany();
    await ctx.prisma.user.deleteMany();

    const owner = await loginAs('bal-owner');
    reader = await loginAs('bal-reader');
    other = await loginAs('bal-other');

    creatorId = (
      await ctx.prisma.creator.create({
        data: {
          patreonCampaignId: 'bal-campaign',
          ownerUserId: owner.userId,
          displayName: 'Balance Co',
          slug: 'balance-co',
          policy: { create: { viewVisibility: 'PUBLIC', redeemTokensEnabled: true } },
        },
      })
    ).id;

    tierId = (
      await ctx.prisma.tier.create({
        data: {
          creatorId,
          patreonTierId: 'bal-tier',
          title: 'Producer',
          amountCents: 1500,
          order: 0,
          tokensPerPeriod: 3,
        },
      })
    ).id;
  });

  const patronise = (who: Auth) =>
    ctx.prisma.membership.create({
      data: {
        userId: who.userId,
        creatorId,
        currentTierId: tierId,
        isActivePatron: true,
        amountCents: 1500,
      },
    });

  const getBalance = (who: Auth) =>
    request(ctx.app.getHttpServer())
      .get('/api/v1/creators/balance-co/tokens')
      .set('Cookie', [who.session, who.csrf]);

  it('grants the period due before answering', async () => {
    // The lazy grant: no cron, no fan-out. A reader who looks is granted what they are owed.
    await patronise(reader);
    const res = await getBalance(reader).expect(200);

    expect(res.body.available).toBe(3);
    expect(await ctx.prisma.tokenLedger.count({ where: { userId: reader.userId } })).toBe(1);
  });

  it('does not grant twice when the balance is read twice', async () => {
    await patronise(reader);
    await getBalance(reader).expect(200);
    const second = await getBalance(reader).expect(200);

    expect(second.body.available).toBe(3);
    expect(await ctx.prisma.tokenLedger.count({ where: { userId: reader.userId } })).toBe(1);
  });

  it('returns the ledger that explains the balance', async () => {
    await patronise(reader);
    const res = await getBalance(reader).expect(200);

    expect(res.body.ledger).toHaveLength(1);
    expect(res.body.ledger[0]).toMatchObject({ kind: 'TIER_GRANT', amount: 3 });
  });

  it('answers zero for a reader who is owed nothing', async () => {
    const res = await getBalance(reader).expect(200);
    expect(res.body.available).toBe(0);
    expect(res.body.ledger).toEqual([]);
  });

  it('never returns another reader a balance', async () => {
    // Each caller reads their own and only their own. There is no route that takes a user id,
    // which is the strongest form of this rule: the question cannot be asked.
    await patronise(reader);
    await patronise(other);
    await getBalance(reader).expect(200);

    const mine = await getBalance(other).expect(200);
    expect(mine.body.available).toBe(3);
    const ledgerUsers = await ctx.prisma.tokenLedger.findMany({ select: { userId: true } });
    expect(new Set(ledgerUsers.map((row) => row.userId)).size).toBe(2);
  });

  it('refuses an anonymous caller', async () => {
    await request(ctx.app.getHttpServer()).get('/api/v1/creators/balance-co/tokens').expect(401);
  });

  it('is empty and harmless on a board with the feature off', async () => {
    await ctx.prisma.creatorPolicy.update({
      where: { creatorId },
      data: { redeemTokensEnabled: false },
    });
    await patronise(reader);

    const res = await getBalance(reader).expect(200);
    expect(res.body.available).toBe(0);
    expect(res.body.enabled).toBe(false);
  });

  it('says the feature is on when it is', async () => {
    // The client needs to know whether to render any of this at all, and a balance of zero on an
    // enabled board is a different thing from a board that has no tokens.
    await patronise(reader);
    const res = await getBalance(reader).expect(200);
    expect(res.body.enabled).toBe(true);
  });

  it('404s for a board that does not exist', async () => {
    await request(ctx.app.getHttpServer())
      .get('/api/v1/creators/no-such-board/tokens')
      .set('Cookie', [reader.session, reader.csrf])
      .expect(404);
  });
});
