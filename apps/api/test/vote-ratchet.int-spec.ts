import request from 'supertest';
import { AuthTestContext, pickCookie, startAuthApp } from './support/auth-app';

describe('Vote ratchet (integration)', () => {
  let ctx: AuthTestContext;
  let creatorId: string;
  let owner: Auth;
  let voter: Auth;
  let voterId: string;
  let tiers: Record<string, string> = {};
  let entryId: string;
  let secondId: string;

  beforeAll(async () => {
    ctx = await startAuthApp();
    owner = await loginAs('vr-owner');
    creatorId = (
      await ctx.prisma.creator.create({
        data: {
          patreonCampaignId: 'vr-campaign',
          ownerUserId: await userId('vr-owner'),
          displayName: 'Ratchet Co',
          slug: 'ratchet-co',
          policy: { create: {} },
          staff: { create: { userId: await userId('vr-owner'), role: 'OWNER' } },
        },
      })
    ).id;
    for (const [key, weight, order] of [
      ['small', 2, 0],
      ['big', 20, 1],
    ] as const) {
      tiers[key] = (
        await ctx.prisma.tier.create({
          data: {
            creatorId,
            patreonTierId: `vr-${key}`,
            title: key,
            amountCents: weight * 100,
            voteWeight: weight,
            order,
          },
        })
      ).id;
    }
    voter = await loginAs('vr-voter');
    voterId = await userId('vr-voter');
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.prisma.upvote.deleteMany();
    await ctx.prisma.recommendation.deleteMany();
    await ctx.prisma.membership.deleteMany({ where: { creatorId } });
    await ctx.prisma.creatorPolicy.update({
      where: { creatorId },
      data: { allowVoteRatchet: true },
    });
    await setTier('small');
    const made = [];
    for (const title of ['Akira', 'Ponyo']) {
      made.push(
        await ctx.prisma.recommendation.create({
          data: {
            creatorId,
            submittedByUserId: voterId,
            type: 'EXTERNAL_LINK',
            customTitle: title,
            normalizedTitle: title.toLowerCase(),
            status: 'PENDING',
          },
        }),
      );
    }
    entryId = made[0].id;
    secondId = made[1].id;
  });

  const setTier = async (key: 'small' | 'big') =>
    ctx.prisma.membership.upsert({
      where: { userId_creatorId: { userId: voterId, creatorId } },
      create: {
        userId: voterId,
        creatorId,
        currentTierId: tiers[key],
        amountCents: 500,
        isActivePatron: true,
      },
      update: { currentTierId: tiers[key] },
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

  const upvote = (auth: Auth, id: string) =>
    request(ctx.app.getHttpServer())
      .post(`/api/v1/creators/ratchet-co/recommendations/${id}/upvote`)
      .set('Cookie', [auth.session, auth.csrf])
      .set('x-csrf-token', auth.csrfToken);

  const myVotes = (auth: Auth) =>
    request(ctx.app.getHttpServer())
      .get('/api/v1/creators/ratchet-co/my-votes')
      .set('Cookie', [auth.session, auth.csrf]);

  const refresh = (auth: Auth) =>
    request(ctx.app.getHttpServer())
      .post('/api/v1/creators/ratchet-co/my-votes/refresh')
      .set('Cookie', [auth.session, auth.csrf])
      .set('x-csrf-token', auth.csrfToken);

  const scoreOf = async (id: string) =>
    (
      await ctx.prisma.recommendation.findUniqueOrThrow({
        where: { id },
        select: { weightedScore: true },
      })
    ).weightedScore;

  describe('seeing what a vote is worth', () => {
    it('lists what the reader voted for, and what each is worth', async () => {
      await upvote(voter, entryId).expect(201);

      const res = await myVotes(voter).expect(200);

      expect(res.body.items).toEqual([
        expect.objectContaining({ recommendationId: entryId, title: 'Akira', worth: 2 }),
      ]);
    });

    it('says nothing can be improved while the tier has not changed', async () => {
      await upvote(voter, entryId).expect(201);

      expect((await myVotes(voter).expect(200)).body).toMatchObject({ couldImprove: 0 });
    });

    it('counts what an upgrade would lift', async () => {
      await upvote(voter, entryId).expect(201);
      await upvote(voter, secondId).expect(201);
      await setTier('big');

      const res = await myVotes(voter).expect(200);

      expect(res.body.couldImprove).toBe(2);
      expect(res.body.currentWorth).toBe(20);
    });

    it('never shows one reader the votes of another', async () => {
      await upvote(voter, entryId).expect(201);

      expect((await myVotes(owner).expect(200)).body.items).toEqual([]);
    });

    it('needs a session', async () => {
      await request(ctx.app.getHttpServer())
        .get('/api/v1/creators/ratchet-co/my-votes')
        .expect(401);
    });
  });

  describe('lifting votes to the current tier', () => {
    it('raises a vote cast at a cheaper tier', async () => {
      await upvote(voter, entryId).expect(201);
      expect(await scoreOf(entryId)).toBe(2);
      await setTier('big');

      const res = await refresh(voter).expect(200);

      expect(res.body).toEqual({ updated: 1 });
      expect(await scoreOf(entryId)).toBe(20);
    });

    it('never lowers one', async () => {
      // The point of the thing: paying more, even once, is not taken back when someone downgrades.
      await setTier('big');
      await upvote(voter, entryId).expect(201);
      expect(await scoreOf(entryId)).toBe(20);
      await setTier('small');

      expect((await refresh(voter).expect(200)).body).toEqual({ updated: 0 });
      expect(await scoreOf(entryId)).toBe(20);
    });

    it('leaves the headcount alone', async () => {
      await upvote(voter, entryId).expect(201);
      await setTier('big');

      await refresh(voter).expect(200);

      const entry = await ctx.prisma.recommendation.findUniqueOrThrow({
        where: { id: entryId },
        select: { upvoteCount: true },
      });
      expect(entry.upvoteCount).toBe(1);
    });

    it('lifts every vote the reader holds on this board', async () => {
      await upvote(voter, entryId).expect(201);
      await upvote(voter, secondId).expect(201);
      await setTier('big');

      expect((await refresh(voter).expect(200)).body).toEqual({ updated: 2 });
      expect(await scoreOf(entryId)).toBe(20);
      expect(await scoreOf(secondId)).toBe(20);
    });

    it('is refused when the creator has turned it off', async () => {
      // A board that wants a live signal rather than a record of historical generosity.
      await ctx.prisma.creatorPolicy.update({
        where: { creatorId },
        data: { allowVoteRatchet: false },
      });
      await upvote(voter, entryId).expect(201);
      await setTier('big');

      await refresh(voter).expect(403);

      expect(await scoreOf(entryId)).toBe(2);
    });

    it('does nothing for a member on no particular tier', async () => {
      // A member without a tier votes at one, which is already the floor — there is nothing to
      // lift them to. Removing the membership outright is a different case: it takes the UPVOTE
      // capability with it, so the endpoint is not theirs to call at all.
      await upvote(voter, entryId).expect(201);
      await ctx.prisma.membership.update({
        where: { userId_creatorId: { userId: voterId, creatorId } },
        data: { currentTierId: null },
      });

      expect((await refresh(voter).expect(200)).body).toEqual({ updated: 0 });
    });
  });
});
