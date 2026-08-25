import request from 'supertest';
import { AuthTestContext, pickCookie, startAuthApp } from './support/auth-app';

describe('Grouping (integration)', () => {
  let ctx: AuthTestContext;
  let creatorId: string;
  let owner: Auth;
  let mover: Auth;
  let bystander: Auth;
  let patron: Auth;
  let tiers: Record<string, string> = {};
  let head: string;
  let child: string;

  beforeAll(async () => {
    ctx = await startAuthApp();
    owner = await loginAs('gr-owner');
    creatorId = (
      await ctx.prisma.creator.create({
        data: {
          patreonCampaignId: 'gr-campaign',
          ownerUserId: await userId('gr-owner'),
          displayName: 'Group Co',
          slug: 'group-co',
          policy: { create: {} },
          staff: { create: { userId: await userId('gr-owner'), role: 'OWNER' } },
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
            patreonTierId: `gr-${key}`,
            title: key,
            amountCents: weight * 100,
            voteWeight: weight,
            order,
          },
        })
      ).id;
    }

    mover = await loginAs('gr-mover');
    await ctx.prisma.creatorStaff.create({
      data: {
        creatorId,
        userId: await userId('gr-mover'),
        role: 'MOD',
        permissions: ['MOVE_ENTRIES'],
      },
    });
    bystander = await loginAs('gr-bystander');
    await ctx.prisma.creatorStaff.create({
      data: {
        creatorId,
        userId: await userId('gr-bystander'),
        role: 'MOD',
        permissions: ['WRITE_NOTES'],
      },
    });
    patron = await loginAs('gr-patron');
    await ctx.prisma.membership.create({
      data: {
        userId: await userId('gr-patron'),
        creatorId,
        amountCents: 500,
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
    head = (await makeEntry('Re Zero Season 1')).id;
    child = (await makeEntry('Re Zero Season 3')).id;
  });

  const makeEntry = async (title: string) =>
    ctx.prisma.recommendation.create({
      data: {
        creatorId,
        submittedByUserId: await userId('gr-patron'),
        type: 'EXTERNAL_LINK',
        customTitle: title,
        normalizedTitle: title.toLowerCase(),
        status: 'PENDING',
      },
    });

  const userId = async (patreonUserId: string) =>
    (await ctx.prisma.user.findUniqueOrThrow({ where: { patreonUserId } })).id;

  /** A vote cast at a named tier, written directly so the fixture controls the weight. */
  const voteAt = async (recommendationId: string, who: string, tier: 'small' | 'big') => {
    const id = await userId(who);
    await ctx.prisma.upvote.create({ data: { recommendationId, userId: id, tierId: tiers[tier] } });
    const weight = tier === 'big' ? 20 : 2;
    await ctx.prisma.recommendation.update({
      where: { id: recommendationId },
      data: { upvoteCount: { increment: 1 }, weightedScore: { increment: weight } },
    });
  };

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

  const group = (auth: Auth, id: string, intoId: string) =>
    request(ctx.app.getHttpServer())
      .post(`/api/v1/creators/group-co/recommendations/${id}/group`)
      .set('Cookie', [auth.session, auth.csrf])
      .set('x-csrf-token', auth.csrfToken)
      .send({ intoId });

  const ungroup = (auth: Auth, id: string) =>
    request(ctx.app.getHttpServer())
      .delete(`/api/v1/creators/group-co/recommendations/${id}/group`)
      .set('Cookie', [auth.session, auth.csrf])
      .set('x-csrf-token', auth.csrfToken);

  const totals = async (id: string) =>
    ctx.prisma.recommendation.findUniqueOrThrow({
      where: { id },
      select: { weightedScore: true, upvoteCount: true, groupHeadId: true },
    });

  describe('grouping', () => {
    it('nests the child under the head', async () => {
      await group(mover, child, head).expect(204);

      expect((await totals(child)).groupHeadId).toBe(head);
    });

    it('adds the group up on the head', async () => {
      await voteAt(head, 'gr-patron', 'small');
      await voteAt(child, 'gr-owner', 'big');

      await group(mover, child, head).expect(204);

      // Two people, 2 + 20.
      expect(await totals(head)).toMatchObject({ weightedScore: 22, upvoteCount: 2 });
    });

    it('counts someone who upvoted both entries once, at their higher tier', async () => {
      // The trap the theme merge hit: counting them twice inflates the head silently, and
      // nothing about the number says it is wrong.
      await voteAt(head, 'gr-patron', 'small');
      await voteAt(child, 'gr-patron', 'big');

      await group(mover, child, head).expect(204);

      expect(await totals(head)).toMatchObject({ weightedScore: 20, upvoteCount: 1 });
    });

    it('leaves the child own totals alone, since grouping preserves', async () => {
      await voteAt(child, 'gr-owner', 'big');

      await group(mover, child, head).expect(204);

      expect(await totals(child)).toMatchObject({ weightedScore: 20, upvoteCount: 1 });
    });

    it('restores both when ungrouped', async () => {
      await voteAt(head, 'gr-patron', 'small');
      await voteAt(child, 'gr-patron', 'big');
      await group(mover, child, head).expect(204);

      await ungroup(mover, child).expect(204);

      expect(await totals(head)).toMatchObject({ weightedScore: 2, upvoteCount: 1 });
      expect(await totals(child)).toMatchObject({
        weightedScore: 20,
        upvoteCount: 1,
        groupHeadId: null,
      });
    });

    it('carries a vote cast after grouping up to the head', async () => {
      // The head's totals are derived state. A vote lands on the entry it was cast on, so
      // without this the group's number quietly stops matching its members.
      await group(mover, child, head).expect(204);

      await request(ctx.app.getHttpServer())
        .post(`/api/v1/creators/group-co/recommendations/${child}/upvote`)
        .set('Cookie', [patron.session, patron.csrf])
        .set('x-csrf-token', patron.csrfToken)
        .expect(201);

      expect(await totals(head)).toMatchObject({ upvoteCount: 1 });
    });

    it('refuses to group an entry into itself', async () => {
      await group(mover, head, head).expect(400);
    });

    it('refuses to nest a group inside another group', async () => {
      // One level. Arbitrary depth makes the de-duplicated sum a recursive walk and "which card
      // do I open" unanswerable.
      const third = await makeEntry('Re Zero Season 2');
      await group(mover, child, head).expect(204);

      await group(mover, head, third.id).expect(409);
      await group(mover, third.id, child).expect(409);
    });

    it('404s an entry on another board', async () => {
      const other = await ctx.prisma.creator.create({
        data: {
          patreonCampaignId: 'gr-other',
          ownerUserId: await userId('gr-owner'),
          displayName: 'Other',
          slug: 'gr-other',
          policy: { create: {} },
        },
      });
      const foreign = await ctx.prisma.recommendation.create({
        data: {
          creatorId: other.id,
          submittedByUserId: await userId('gr-patron'),
          type: 'EXTERNAL_LINK',
          customTitle: 'Elsewhere',
          normalizedTitle: 'elsewhere',
        },
      });

      await group(mover, child, foreign.id).expect(404);
      await group(mover, foreign.id, head).expect(404);

      await ctx.prisma.creator.delete({ where: { id: other.id } });
    });

    it('releases the children rather than deleting them when a head goes', async () => {
      await group(mover, child, head).expect(204);

      await ctx.prisma.recommendation.delete({ where: { id: head } });

      expect(await totals(child)).toMatchObject({ groupHeadId: null });
    });
  });

  describe('who may', () => {
    it('refuses a moderator without MOVE_ENTRIES', async () => {
      await group(bystander, child, head).expect(403);
    });

    it('refuses a patron', async () => {
      await group(patron, child, head).expect(403);
    });

    it('allows the owner, who holds everything by role', async () => {
      await group(owner, child, head).expect(204);
    });
  });

  describe('on the board', () => {
    it('nests the child inside the head rather than listing it separately', async () => {
      await group(mover, child, head).expect(204);

      const res = await request(ctx.app.getHttpServer())
        .get('/api/v1/creators/group-co/recommendations')
        .set('Cookie', [patron.session, patron.csrf])
        .expect(200);

      const childRow = res.body.items.find((i: { id: string }) => i.id === child);
      expect(childRow.parentId).toBe(head);
    });
  });
});
