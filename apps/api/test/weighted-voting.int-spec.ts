import request from 'supertest';
import { AuthTestContext, pickCookie, startAuthApp } from './support/auth-app';
import { ALL_STAFF_PERMISSIONS } from '../src/access/permissions';

describe('Weighted voting (integration)', () => {
  let ctx: AuthTestContext;
  let creatorId: string;
  let owner: Auth;
  let mod: Auth;
  let big: Auth;
  let small: Auth;
  let noTier: Auth;
  let tiers: Record<string, string> = {};
  let entryId: string;

  beforeAll(async () => {
    ctx = await startAuthApp();
    owner = await loginAs('wv-owner');
    creatorId = (
      await ctx.prisma.creator.create({
        data: {
          patreonCampaignId: 'wv-campaign',
          ownerUserId: await userId('wv-owner'),
          displayName: 'Weight Co',
          slug: 'weight-co',
          policy: { create: {} },
          staff: { create: { userId: await userId('wv-owner'), role: 'OWNER' } },
        },
      })
    ).id;
    for (const [key, patreonTierId, amountCents, order] of [
      ['producer', 'wv-tier-big', 1500, 1],
      ['sidekick', 'wv-tier-small', 500, 0],
    ] as const) {
      tiers[key] = (
        await ctx.prisma.tier.create({
          data: { creatorId, patreonTierId, title: key, amountCents, order },
        })
      ).id;
    }

    mod = await loginAs('wv-mod');
    await ctx.prisma.creatorStaff.create({
      data: {
        creatorId,
        userId: await userId('wv-mod'),
        role: 'MOD',
        permissions: ALL_STAFF_PERMISSIONS,
      },
    });
    big = await loginAs('wv-big');
    small = await loginAs('wv-small');
    noTier = await loginAs('wv-notier');
    for (const [who, tier, cents] of [
      ['wv-big', tiers.producer, 1500],
      ['wv-small', tiers.sidekick, 500],
    ] as const) {
      await ctx.prisma.membership.create({
        data: {
          userId: await userId(who),
          creatorId,
          currentTierId: tier,
          amountCents: cents,
          isActivePatron: true,
        },
      });
    }
    // Deliberately without a tier: a board that lets non-patrons vote is letting them vote.
    await ctx.prisma.membership.create({
      data: {
        userId: await userId('wv-notier'),
        creatorId,
        amountCents: 100,
        isActivePatron: true,
      },
    });
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.prisma.upvote.deleteMany();
    await ctx.prisma.recommendation.deleteMany();
    await ctx.prisma.tier.updateMany({ where: { creatorId }, data: { voteWeight: 1 } });
    entryId = (
      await ctx.prisma.recommendation.create({
        data: {
          creatorId,
          submittedByUserId: await userId('wv-small'),
          type: 'EXTERNAL_LINK',
          customTitle: 'Akira',
          normalizedTitle: 'akira',
          status: 'PENDING',
        },
      })
    ).id;
  });

  const userId = async (patreonUserId: string) =>
    (await ctx.prisma.user.findUniqueOrThrow({ where: { patreonUserId } })).id;

  async function loginAs(patreonUserId: string) {
    ctx.patreon.identity = { ...ctx.patreon.identity, patreonUserId, memberships: [] };
    const start = await request(ctx.app.getHttpServer()).get('/auth/patreon/login').expect(302);
    const state = new URL(start.headers.location).searchParams.get('state') as string;
    const res = await request(ctx.app.getHttpServer())
      .get(`/auth/patreon/callback?code=auth-code&state=${state}`)
      .set('Cookie', pickCookie(start, 'pp_oauth_state'))
      .expect(302);
    const csrf = pickCookie(res, 'pp_csrf').split(';')[0];
    return {
      session: pickCookie(res, 'pp_session'),
      csrf,
      csrfToken: csrf.split('=').slice(1).join('='),
    };
  }

  type Auth = Awaited<ReturnType<typeof loginAs>>;

  const setWeight = (auth: Auth, tierId: string, voteWeight: number) =>
    request(ctx.app.getHttpServer())
      .patch(`/api/v1/creators/weight-co/tiers/${tierId}`)
      .set('Cookie', [auth.session, auth.csrf])
      .set('x-csrf-token', auth.csrfToken)
      .send({ voteWeight });

  const upvote = (auth: Auth, id = entryId) =>
    request(ctx.app.getHttpServer())
      .post(`/api/v1/creators/weight-co/recommendations/${id}/upvote`)
      .set('Cookie', [auth.session, auth.csrf])
      .set('x-csrf-token', auth.csrfToken);

  const scoreOf = async (id = entryId) =>
    ctx.prisma.recommendation.findUniqueOrThrow({
      where: { id },
      select: { weightedScore: true, upvoteCount: true },
    });

  describe('what a tier is worth', () => {
    it('is one until a creator says otherwise', async () => {
      const tier = await ctx.prisma.tier.findUniqueOrThrow({ where: { id: tiers.producer } });
      expect(tier.voteWeight).toBe(1);
    });

    it('is the owner to set', async () => {
      await setWeight(owner, tiers.producer, 15).expect(200);

      const tier = await ctx.prisma.tier.findUniqueOrThrow({ where: { id: tiers.producer } });
      expect(tier.voteWeight).toBe(15);
    });

    it('is not a moderator to set', async () => {
      // What a tier is worth is board policy, beside the paywall — not day-to-day curation.
      await setWeight(mod, tiers.producer, 15).expect(403);
    });

    it('refuses a negative weight', async () => {
      await setWeight(owner, tiers.producer, -5).expect(400);
    });

    it('404s a tier on another board', async () => {
      const other = await ctx.prisma.creator.create({
        data: {
          patreonCampaignId: 'wv-other',
          ownerUserId: await userId('wv-owner'),
          displayName: 'Other',
          slug: 'wv-other',
          policy: { create: {} },
        },
      });
      const foreign = await ctx.prisma.tier.create({
        data: {
          creatorId: other.id,
          patreonTierId: 'wv-foreign',
          title: 'Theirs',
          amountCents: 100,
          order: 0,
        },
      });

      await setWeight(owner, foreign.id, 9).expect(404);

      await ctx.prisma.creator.delete({ where: { id: other.id } });
    });
  });

  describe('casting a vote', () => {
    it('records the tier the voter held', async () => {
      await upvote(big).expect(201);

      const vote = await ctx.prisma.upvote.findFirstOrThrow({
        where: { recommendationId: entryId },
      });
      expect(vote.tierId).toBe(tiers.producer);
    });

    it('counts a voter with no tier as one', async () => {
      // Free is handled by whether they may vote at all, not by making the vote worth nothing.
      await upvote(noTier).expect(201);

      expect(await scoreOf()).toEqual({ weightedScore: 1, upvoteCount: 1 });
    });

    it('adds what the tier is worth', async () => {
      await setWeight(owner, tiers.producer, 15).expect(200);
      await setWeight(owner, tiers.sidekick, 5).expect(200);

      await upvote(big).expect(201);
      await upvote(small).expect(201);

      // Two people, twenty points: both numbers, because they answer different questions.
      expect(await scoreOf()).toEqual({ weightedScore: 20, upvoteCount: 2 });
    });

    it('takes the weight back when the vote is withdrawn', async () => {
      await setWeight(owner, tiers.producer, 15).expect(200);
      await upvote(big).expect(201);

      await upvote(big).expect(201);

      expect(await scoreOf()).toEqual({ weightedScore: 0, upvoteCount: 0 });
    });
  });

  describe('the board', () => {
    it('ranks by weight rather than by headcount', async () => {
      await setWeight(owner, tiers.producer, 15).expect(200);
      const second = await ctx.prisma.recommendation.create({
        data: {
          creatorId,
          submittedByUserId: await userId('wv-small'),
          type: 'EXTERNAL_LINK',
          customTitle: 'Ponyo',
          normalizedTitle: 'ponyo',
          status: 'PENDING',
        },
      });
      // One big backer against two small ones: fewer people, more support.
      await upvote(big).expect(201);
      await upvote(small, second.id).expect(201);
      await upvote(noTier, second.id).expect(201);

      const res = await request(ctx.app.getHttpServer())
        .get('/api/v1/creators/weight-co/recommendations')
        .set('Cookie', [small.session, small.csrf])
        .expect(200);

      expect(res.body.items.map((i: { customTitle: string }) => i.customTitle)).toEqual([
        'Akira',
        'Ponyo',
      ]);
      expect(res.body.items[0]).toMatchObject({ weightedScore: 15, upvoteCount: 1 });
      expect(res.body.items[1]).toMatchObject({ weightedScore: 2, upvoteCount: 2 });
    });
  });

  describe('a rebalance', () => {
    it('reaches votes already cast', async () => {
      // The vote records its tier, not a copied number, so changing what the tier is worth
      // changes what the vote is worth. That is the point of storing the reference.
      await upvote(big).expect(201);
      expect((await scoreOf()).weightedScore).toBe(1);

      await setWeight(owner, tiers.producer, 20).expect(200);

      expect((await scoreOf()).weightedScore).toBe(20);
    });

    it('lowers a score as readily as it raises one', async () => {
      await setWeight(owner, tiers.producer, 20).expect(200);
      await upvote(big).expect(201);

      await setWeight(owner, tiers.producer, 2).expect(200);

      expect((await scoreOf()).weightedScore).toBe(2);
    });

    it('leaves votes cast at other tiers alone', async () => {
      await setWeight(owner, tiers.sidekick, 5).expect(200);
      await upvote(small).expect(201);
      await upvote(big).expect(201);
      expect((await scoreOf()).weightedScore).toBe(6);

      await setWeight(owner, tiers.producer, 10).expect(200);

      expect((await scoreOf()).weightedScore).toBe(15);
    });
  });
});
