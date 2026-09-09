import request from 'supertest';
import { EmbedTitlesJob } from '../src/jobs/embed-titles.job';
import { MAX_SEARCH_RESULTS } from '../src/recommendations/search.service';
import { AuthTestContext, pickCookie, startAuthApp } from './support/auth-app';
import { ALL_STAFF_PERMISSIONS } from '../src/access/permissions';

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
        policy: { create: { viewVisibility: 'PUBLIC' } },
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
          policy: { create: { viewVisibility: 'PUBLIC' } },
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
        permissions: ALL_STAFF_PERMISSIONS,
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

    it('finds a long title from one word of it', async () => {
      // The type-ahead case. Plain `similarity()` scores "spirited" against this at 0.26 —
      // below any usable threshold — because it penalises the length of the target.
      const longId = (await entry('Spirited Away in the Land of the Gods')).id;
      expect(ids((await search(patron, 'spirited').expect(200)).body)).toContain(longId);
      expect(ids((await search(patron, 'gods').expect(200)).body)).toContain(longId);
    });

    it('finds an entry from a partial word', async () => {
      expect(ids((await search(patron, 'neigh').expect(200)).body)).toContain(totoroId);
    });

    it('returns entries in the same shape as the board', async () => {
      const [fromSearch, fromBoard] = await Promise.all([
        search(patron, 'totoro').expect(200),
        request(ctx.app.getHttpServer())
          .get('/api/v1/creators/search-co/recommendations?limit=50')
          .set('Cookie', [patron.session, patron.csrf])
          .expect(200),
      ]);
      const boardEntry = fromBoard.body.items.find((i: { id: string }) => i.id === totoroId);
      expect(Object.keys(fromSearch.body.items[0]).sort()).toEqual(Object.keys(boardEntry).sort());
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

  describe('semantic matching', () => {
    // The fake declares equivalences rather than modelling meaning; the real model is verified
    // by `pnpm --filter @app/api verify:embeddings`, which asserts the cross-language property
    // against actual weights.
    async function embed() {
      const job = ctx.app.get(EmbedTitlesJob);
      await job.runOnce();
    }

    beforeEach(async () => {
      ctx.embeddings.configured = true;
      ctx.embeddings.synonyms.clear();
    });

    it('finds a title by meaning when no letters match', async () => {
      const title = await ctx.prisma.title.create({
        data: { tmdbId: 9001, mediaType: 'TV', name: 'Cowboy Bebop' },
      });
      const bebopId = (await entry('Cowboy Bebop', { titleId: title.id })).id;
      // Deliberately shares no word and no trigram with the title. An earlier version used
      // "space cowboys", which contains "cowboy" — so the trigram arm found it and the test
      // passed with semantic search entirely disabled.
      const query = 'bounty hunters in orbit';
      expect(query).not.toMatch(/cowboy|bebop/i);
      ctx.embeddings.near(query, 'cowboy bebop');

      // Without the vector arm there is nothing to match on at all.
      ctx.embeddings.configured = false;
      expect(ids((await search(patron, query).expect(200)).body)).not.toContain(bebopId);

      ctx.embeddings.configured = true;
      await embed();
      expect(ids((await search(patron, query).expect(200)).body)).toContain(bebopId);
    });

    it('does not offer an unrelated entry just because it is the nearest one', async () => {
      // Nearest-neighbour with no floor returns the closest rows however far away they are, so on
      // a small board every query matched everything. That reaches the reader: this endpoint is
      // what the submit form asks as they type, and it answers "already on the board — upvote
      // instead?" — a prompt that is wrong is worse than one that is missing.
      const title = await ctx.prisma.title.create({
        data: { tmdbId: 9002, mediaType: 'TV', name: 'Serial Experiments Lain' },
      });
      const lainId = (await entry('Serial Experiments Lain', { titleId: title.id })).id;
      await embed();

      // No shared trigram and no declared equivalence, so the only arm that could return it is
      // the vector one.
      const res = await search(patron, 'quarterly tax filing spreadsheet').expect(200);

      expect(ids(res.body)).not.toContain(lainId);
    });

    it('still finds a genuine match once the floor is in place', async () => {
      // The floor must not cost recall. Missing a duplicate is the failure this whole feature
      // exists to prevent; showing a stray one merely annoys.
      const title = await ctx.prisma.title.create({
        data: { tmdbId: 9003, mediaType: 'TV', name: 'Ergo Proxy' },
      });
      const proxyId = (await entry('Ergo Proxy', { titleId: title.id })).id;
      const query = 'androids questioning their purpose';
      ctx.embeddings.near(query, 'ergo proxy');
      await embed();

      expect(ids((await search(patron, query).expect(200)).body)).toContain(proxyId);
    });

    it('still finds trigram matches when the model is unavailable', async () => {
      // Semantic matching improves a working feature; it is never a dependency of one.
      ctx.embeddings.configured = false;
      expect(ids((await search(patron, 'sprited away').expect(200)).body)).toContain(spiritedId);
    });

    it('applies the same visibility rules to semantic candidates', async () => {
      // A new candidate source is a new way to bypass the filter if the ids do not go through
      // the same read model.
      const title = await ctx.prisma.title.create({
        data: { tmdbId: 9002, mediaType: 'MOVIE', name: 'Hidden Thing' },
      });
      const hidden = await entry('Hidden Thing', { titleId: title.id, status: 'REJECTED' });
      ctx.embeddings.near('completely different words', 'hidden thing');
      await embed();

      const res = await search(patron, 'completely different words').expect(200);
      expect(ids(res.body)).not.toContain(hidden.id);
    });

    it('never returns another creator entries by semantic match', async () => {
      const title = await ctx.prisma.title.create({
        data: { tmdbId: 9003, mediaType: 'MOVIE', name: 'Foreign Thing' },
      });
      const foreign = await entry('Foreign Thing', {
        titleId: title.id,
        creator: otherCreatorId,
      });
      ctx.embeddings.near('unrelated phrase', 'foreign thing');
      await embed();

      const res = await search(patron, 'unrelated phrase').expect(200);
      expect(ids(res.body)).not.toContain(foreign.id);
    });

    it('ignores a vector written by a model this deployment no longer uses', async () => {
      // A stale vector lives in a different space; comparing across them produces confident
      // nonsense rather than an error.
      const title = await ctx.prisma.title.create({
        data: { tmdbId: 9004, mediaType: 'MOVIE', name: 'Stale Thing' },
      });
      const stale = await entry('Stale Thing', { titleId: title.id });
      ctx.embeddings.near('nothing alike', 'stale thing');
      await embed();
      await ctx.prisma.title.update({
        where: { id: title.id },
        data: { embeddingModel: 'previous/model' },
      });

      const res = await search(patron, 'nothing alike').expect(200);
      expect(ids(res.body)).not.toContain(stale.id);
    });
  });

  describe('bounds', () => {
    it('refuses a query too short to rank, rather than scanning the table', async () => {
      await search(patron, 'a').expect(400);
      await search(patron, '').expect(400);
    });

    it('caps the number of results', async () => {
      // Asserted as equality: `toBeLessThanOrEqual` passes on an empty list, which is exactly
      // the failure that hid hidden entries crowding out visible ones.
      for (let i = 0; i < MAX_SEARCH_RESULTS + 5; i += 1) await entry(`Matrix Sequel ${i}`);
      const res = await search(patron, 'matrix sequel').expect(200);
      expect(res.body.items).toHaveLength(MAX_SEARCH_RESULTS);
    });

    it('is not blinded by hidden entries filling the candidate window', async () => {
      // Rejected near-duplicates are what moderating spam on a popular title produces, and
      // DELETED rows accumulate forever. Ranking them into every candidate slot and filtering
      // afterwards returned *nothing* — silently blinding search for that title.
      for (let i = 0; i < MAX_SEARCH_RESULTS * 2; i += 1) {
        await entry(`Matrix Clone ${i}`, { status: 'REJECTED' });
      }
      const res = await search(patron, 'the matrix').expect(200);
      expect(ids(res.body)).toContain(matrixId);
    });

    it('rejects a query carrying a control character', async () => {
      // A NUL byte reached Postgres as 22021 and came back as an anonymous, repeatable 500.
      await search(patron, 'spirit\u0000ed').expect(400);
    });

    it('treats a query of pure punctuation as too short', async () => {
      // It normalises to nothing, and a trigram match on "" would rank everything.
      await search(patron, '!!!').expect(400);
    });
  });
});
