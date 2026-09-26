import request from 'supertest';
import { AuthTestContext, pickCookie, startAuthApp } from './support/auth-app';

/**
 * Consuming a redeem, and telling the reader who spent it.
 *
 * Both happen inside the transaction that moves the entry, for the reason the audit row already
 * lives there: telling somebody their redeem is playing, when the move was rolled back, is worse
 * than not telling them.
 */
describe('Redeem consumption (integration)', () => {
  let ctx: AuthTestContext;
  let creatorId: string;
  let staff: Auth;
  let spender: Auth;
  let follower: Auth;
  let entryId: string;

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
    await ctx.prisma.notification.deleteMany();
    await ctx.prisma.boardNotificationPreference.deleteMany();
    await ctx.prisma.creatorFavorite.deleteMany();
    await ctx.prisma.membership.deleteMany();
    await ctx.prisma.tokenLedger.deleteMany();
    await ctx.prisma.redeem.deleteMany();
    await ctx.prisma.tokenBalance.deleteMany();
    await ctx.prisma.recommendation.deleteMany();
    await ctx.prisma.creatorStaff.deleteMany();
    await ctx.prisma.creatorPolicy.deleteMany();
    await ctx.prisma.creator.deleteMany();
    await ctx.prisma.user.deleteMany();

    staff = await loginAs('rc-staff');
    spender = await loginAs('rc-spender');
    follower = await loginAs('rc-follower');

    const creator = await ctx.prisma.creator.create({
      data: {
        patreonCampaignId: 'rc-campaign',
        ownerUserId: staff.userId,
        displayName: 'Consume Co',
        slug: 'consume-co',
        policy: { create: { viewVisibility: 'PUBLIC', redeemTokensEnabled: true } },
        staff: { create: { userId: staff.userId, role: 'OWNER' } },
      },
    });
    creatorId = creator.id;

    entryId = (
      await ctx.prisma.recommendation.create({
        data: {
          creatorId,
          submittedByUserId: follower.userId,
          type: 'EXTERNAL_LINK',
          customTitle: 'Cowboy Bebop',
          normalizedTitle: 'cowboy bebop',
          status: 'ACCEPTED',
        },
      })
    ).id;
  });

  const giveAndSpend = async (who: Auth, note: string, count = 1) => {
    // A membership, because redeeming is UPVOTE-gated and a board with no pledge floor still
    // requires an active patron. Staff bypass it, which is why the moderator case needs none.
    await ctx.prisma.membership.upsert({
      where: { userId_creatorId: { userId: who.userId, creatorId } },
      create: { userId: who.userId, creatorId, isActivePatron: true, amountCents: 500 },
      update: { isActivePatron: true },
    });
    await ctx.prisma.tokenBalance.upsert({
      where: { creatorId_userId: { creatorId, userId: who.userId } },
      create: { creatorId, userId: who.userId, available: count },
      update: { available: { increment: count } },
    });
    for (let i = 0; i < count; i += 1) {
      await request(ctx.app.getHttpServer())
        .post(`/api/v1/creators/consume-co/recommendations/${entryId}/redeem`)
        .set('Cookie', [who.session, who.csrf])
        .set('x-csrf-token', who.csrfToken)
        .send({ note })
        .expect(201);
    }
  };

  const moveTo = (status: string) =>
    request(ctx.app.getHttpServer())
      .post(`/api/v1/creators/consume-co/recommendations/${entryId}/status`)
      .set('Cookie', [staff.session, staff.csrf])
      .set('x-csrf-token', staff.csrfToken)
      .send({ status });

  const entry = () => ctx.prisma.recommendation.findUniqueOrThrow({ where: { id: entryId } });

  it('consumes every redeem when the entry starts playing', async () => {
    await giveAndSpend(spender, 'S2E04', 2);
    expect((await entry()).unconsumedRedeems).toBe(2);

    await moveTo('ACTIVE').expect(200);

    expect((await entry()).unconsumedRedeems).toBe(0);
    expect(await ctx.prisma.redeem.count({ where: { consumedAt: null } })).toBe(0);
  });

  it('does not return a consumed redeem to the balance', async () => {
    await giveAndSpend(spender, 'S2E04');
    await moveTo('ACTIVE').expect(200);

    const balance = await ctx.prisma.tokenBalance.findUniqueOrThrow({
      where: { creatorId_userId: { creatorId, userId: spender.userId } },
    });
    expect(balance.available).toBe(0);
  });

  it('leaves redeems alone on a move to anything but ACTIVE', async () => {
    await giveAndSpend(spender, 'S2E04');
    await moveTo('REJECTED').expect(200);

    expect((await entry()).unconsumedRedeems).toBe(1);
    expect(await ctx.prisma.redeem.count({ where: { consumedAt: null } })).toBe(1);
  });

  it('tells the reader who redeemed it', async () => {
    await giveAndSpend(spender, 'S2E04');
    await moveTo('ACTIVE').expect(200);

    const told = await ctx.prisma.notification.findMany({
      where: { userId: spender.userId, type: 'REDEEM_PLAYING' },
    });
    expect(told).toHaveLength(1);
  });

  it('tells a redeemer who does not follow the board', async () => {
    // The point of the notification: a redeemer is not necessarily a follower, and the moment
    // the thing they paid for starts is the moment the token pays off.
    await giveAndSpend(spender, 'S2E04');
    const follows = await ctx.prisma.creatorFavorite.count({
      where: { userId: spender.userId },
    });
    expect(follows).toBe(0);

    await moveTo('ACTIVE').expect(200);
    expect(
      await ctx.prisma.notification.count({
        where: { userId: spender.userId, type: 'REDEEM_PLAYING' },
      }),
    ).toBe(1);
  });

  it('tells a reader who spent two tokens exactly once', async () => {
    await giveAndSpend(spender, 'S2E04', 2);
    await moveTo('ACTIVE').expect(200);

    expect(
      await ctx.prisma.notification.count({
        where: { userId: spender.userId, type: 'REDEEM_PLAYING' },
      }),
    ).toBe(1);
  });

  it('does not tell a redeemer twice for also following the board', async () => {
    // ENTRY_MOVED already carries "something moved on a board you follow". A redeemer who
    // follows must hear about their redeem, not hear about the same move twice.
    await giveAndSpend(spender, 'S2E04');
    // Both halves, because the audience is built from the favourite and *then* filtered by the
    // preference. A preference alone leaves the reader out of the ENTRY_MOVED audience entirely,
    // which made an earlier version of this test pass against a build that excluded nobody.
    await ctx.prisma.creatorFavorite.create({
      data: { userId: spender.userId, creatorId },
    });
    await ctx.prisma.boardNotificationPreference.create({
      data: { userId: spender.userId, creatorId, statuses: ['ACTIVE'], themeIds: [] },
    });

    await moveTo('ACTIVE').expect(200);

    const all = await ctx.prisma.notification.findMany({ where: { userId: spender.userId } });
    expect(all).toHaveLength(1);
    expect(all[0].type).toBe('REDEEM_PLAYING');
  });

  it('sends nothing to a redeemer when the move is not to ACTIVE', async () => {
    await giveAndSpend(spender, 'S2E04');
    await moveTo('REJECTED').expect(200);

    expect(
      await ctx.prisma.notification.count({
        where: { userId: spender.userId, type: 'REDEEM_PLAYING' },
      }),
    ).toBe(0);
  });

  it('does not tell a moderator who redeemed and then played it themselves', async () => {
    // Somebody who moved the entry knows what they moved — the same rule the submitter
    // notification already follows.
    await giveAndSpend(staff, 'S2E04');
    await moveTo('ACTIVE').expect(200);

    expect(
      await ctx.prisma.notification.count({
        where: { userId: staff.userId, type: 'REDEEM_PLAYING' },
      }),
    ).toBe(0);
  });
});
