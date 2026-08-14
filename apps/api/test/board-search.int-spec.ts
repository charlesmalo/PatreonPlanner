import request from 'supertest';
import { MAX_SEARCH_RESULTS } from '../src/recommendations/search.service';
import { AuthTestContext, pickCookie, startAuthApp } from './support/auth-app';

describe('Board search (integration)', () => {
  let ctx: AuthTestContext;
  let creatorId: string;
  let otherCreatorId: string;
  let patron: Auth;
  let otherPatron: Auth;
  let staff: Auth;
  let patronUserId: string;

  let spiritedId: string;
  let totoroId: string;
  let matrixId: string;
  let kimiId: string;
  let rejectedId: string;
  let pendingId: string;

  beforeAll(async () => {
    ctx = await startAuthApp();
    const owner = await ctx.prisma.user.create({ data: { patreonUserId: 'bs-owner' } });
    const creator = await ctx.prisma.creator.create({
      data: {
        patreonCampaignId: 'bs-campaign',
        ownerUserId: owner.id,
        displayName: 'Search Co',
        slug: 'search-co',
        policy: { create: {} },
      },
    });
    creatorId = creator.id;
    otherCreatorId = (
      await ctx.prisma.creator.create({
        data: {
          patreonCampaignId: 'bs-other',
          ownerUserId: owner.id,
          displayName: 'Other',
          slug: 'bs-other',
          policy: { create: {} },
        },
      })
    ).id;

    patron = await loginAs('bs-patron');
    patronUserId = (
      await ctx.prisma.user.findUniqueOrThrow({ where: { patreonUserId: 'bs-patron' } })
    ).id;
    await ctx.prisma.membership.create({
      data: { userId: patronUserId, creatorId, amountCents: 500, isActivePatron: true },
    });

    otherPatron = await loginAs('bs-other-patron');
    await ctx.prisma.membership.create({
      data: {
        userId: (
          await ctx.prisma.user.findUniqueOrThrow({
            where: { patreonUserId: 'bs-other-patron' },
          })
        ).id,
        creatorId,
        amountCents: 500,
        isActivePatron: true,
      },
    });

    staff = await loginAs('bs-staff');
    await ctx.prisma.creatorStaff.create({
      data: {
        creatorId,
        userId: (await ctx.prisma.user.findUniqueOrThrow({ where: { patreonUserId: 'bs-staff' } }))
          .id,
        role: 'MOD',
      },
    });
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.availabilityService.drainRefreshes();
    await ctx.prisma.recommendation.deleteMany();
    await ctx.prisma.titleAlias.deleteMany();
    await ctx.prisma.title.deleteMany();
    await setHidePending(false);

    spiritedId = (await entry('Spirited Away')).id;
    totoroId = (await entry('My Neighbour Totoro')).id;
    matrixId = (await entry('The Matrix!')).id;
    rejectedId = (await entry('Removed Thing', { status: 'REJECTED' })).id;
    pendingId = (await entry('Pending Thing', { status: 'PENDING' })).id;

    // A catalogue title whose entry name is Japanese but which TMDB knows in English too.
    const title = await ctx.prisma.title.create({
      data: {
        tmdbId: 372058,
        mediaType: 'MOVIE',
        name: '君の名は。',
        aliases: {
          create: [{ language: 'en', kind: 'OFFICIAL', text: 'Your Name' }],
        },
      },
    });
    kimiId = (await entry('君の名は。', { titleId: title.id })).id;
  });

  async function loginAs(patreonUserId: string) {
    ctx.patreon.identity = { ...ctx.patreon.identity, patreonUserId, memberships: [] };
    const start = await request(ctx.app.getHttpServer()).get('/auth/patreon/login').expect(302);
    const state = new URL(start.headers.location).searchParams.get('state') as string;
    const res = await request(ctx.app.getHttpServer())
      .get(`/auth/patreon/callback?code=auth-code&state=${state}`)
      .set('Cookie', pickCookie(start, 'pp_oauth_state'))
      .expect(302);
    const csrf = pickCookie(res, 'pp_csrf').split(';')[0];
    return { session: pickCookie(res, 'pp_session'), csrf };
  }

  type Auth = Awaited<ReturnType<typeof loginAs>>;

  const normalize = (title: string) =>
    title
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();

  let counter = 0;
  async function entry(
    customTitle: string,
    opts: { status?: 'PENDING' | 'REJECTED'; titleId?: string; creator?: string } = {},
  ) {
    counter += 1;
    return ctx.prisma.recommendation.create({
      data: {
        creatorId: opts.creator ?? creatorId,
        submittedByUserId: patronUserId,
        type: opts.titleId ? 'MOVIE' : 'EXTERNAL_LINK',
        customTitle,
        normalizedTitle: `${normalize(customTitle)}${opts.creator ? ` ${counter}` : ''}`,
        titleId: opts.titleId,
        status: opts.status ?? 'ACCEPTED',
      },
    });
  }

  const setHidePending = (hidePendingFromPublic: boolean) =>
    ctx.prisma.creatorPolicy.update({ where: { creatorId }, data: { hidePendingFromPublic } });

  const search = (auth: Auth | undefined, q: string, slug = 'search-co') => {
    const req = request(ctx.app.getHttpServer()).get(
      `/api/v1/creators/${slug}/recommendations/similar?q=${encodeURIComponent(q)}`,
    );
    return auth ? req.set('Cookie', [auth.session, auth.csrf]) : req;
  };

  const ids = (body: { items: Array<{ id: string }> }) => body.items.map((i) => i.id);

  describe('matching', () => {
    it('finds an entry despite a typo', async () => {
      const res = await search(patron, 'sprited away').expect(200);
      expect(ids(res.body)).toContain(spiritedId);
    });

    it('finds an entry from a fragment of its title', async () => {
      const res = await search(patron, 'totoro').expect(200);
      expect(ids(res.body)).toContain(totoroId);
    });

    it('ignores case and punctuation', async () => {
      // normalizedTitle is the trigram target precisely so these are one string, not three.
      for (const q of ['THE MATRIX', 'the matrix!!', 'The  Matrix']) {
        expect(ids((await search(patron, q).expect(200)).body)).toContain(matrixId);
      }
    });

    it('finds an entry through a catalogue alias in another language', async () => {
      // The one piece of cross-language matching available without an embedding model.
      const res = await search(patron, 'Your Name').expect(200);
      expect(ids(res.body)).toContain(kimiId);
    });

    it('returns nothing for an unrelated query', async () => {
      expect((await search(patron, 'quantum accounting').expect(200)).body.items).toEqual([]);
    });

    it('orders the closest match first', async () => {
      const res = await search(patron, 'the matrix').expect(200);
      expect(res.body.items[0].id).toBe(matrixId);
    });

    it('returns entries in the board shape, so a client can render and upvote them', async () => {
      const res = await search(patron, 'totoro').expect(200);
      expect(res.body.items[0]).toMatchObject({
        id: totoroId,
        customTitle: 'My Neighbour Totoro',
        upvoteCount: expect.any(Number),
        hasUpvoted: false,
      });
    });
  });

  describe('visibility', () => {
    it('never returns a rejected entry', async () => {
      expect(ids((await search(patron, 'removed thing').expect(200)).body)).not.toContain(
        rejectedId,
      );
    });

    it('hides another patron pending entry when the creator hides pending', async () => {
      // The same rule as the board, applied by the same function — this is what proves search
      // did not grow its own copy of the visibility logic.
      await setHidePending(true);
      expect(ids((await search(otherPatron, 'pending thing').expect(200)).body)).not.toContain(
        pendingId,
      );
    });

    it('still shows a patron their own pending entry', async () => {
      await setHidePending(true);
      expect(ids((await search(patron, 'pending thing').expect(200)).body)).toContain(pendingId);
    });

    it('shows staff a rejected entry', async () => {
      expect(ids((await search(staff, 'removed thing').expect(200)).body)).toContain(rejectedId);
    });

    it('never returns another creator entries', async () => {
      await entry('Spirited Away', { creator: otherCreatorId });
      const res = await search(patron, 'spirited away').expect(200);
      expect(ids(res.body)).toEqual([spiritedId]);
    });

    it('answers an anonymous visitor on a public board', async () => {
      expect(ids((await search(undefined, 'totoro').expect(200)).body)).toContain(totoroId);
    });

    it('refuses an anonymous visitor on a gated board', async () => {
      await ctx.prisma.creatorPolicy.update({
        where: { creatorId },
        data: { viewVisibility: 'SUBSCRIBERS_ONLY' },
      });
      await search(undefined, 'totoro').expect(401);
      await ctx.prisma.creatorPolicy.update({
        where: { creatorId },
        data: { viewVisibility: 'PUBLIC' },
      });
    });
  });

  describe('bounds', () => {
    it('refuses a query too short to rank, rather than scanning the table', async () => {
      await search(patron, 'a').expect(400);
      await search(patron, '').expect(400);
    });

    it('caps the number of results', async () => {
      for (let i = 0; i < MAX_SEARCH_RESULTS + 5; i += 1) await entry(`Matrix Sequel ${i}`);
      const res = await search(patron, 'matrix sequel').expect(200);
      expect(res.body.items.length).toBeLessThanOrEqual(MAX_SEARCH_RESULTS);
    });

    it('treats a query of pure punctuation as too short', async () => {
      // It normalises to nothing, and a trigram match on "" would rank everything.
      await search(patron, '!!!').expect(400);
    });
  });
});
