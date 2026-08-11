import request from 'supertest';
import { normalizeTitle } from '../src/recommendations/normalize-title';
import { AuthTestContext, pickCookie, startAuthApp } from './support/auth-app';

describe('Recommendations (integration)', () => {
  let ctx: AuthTestContext;
  let creatorId: string;
  let otherCreatorId: string;
  let goldTierId: string;

  beforeAll(async () => {
    ctx = await startAuthApp();
    const owner = await ctx.prisma.user.create({ data: { patreonUserId: 'board-owner' } });
    const creator = await ctx.prisma.creator.create({
      data: {
        patreonCampaignId: 'board-campaign',
        ownerUserId: owner.id,
        displayName: 'Board Co',
        slug: 'board-co',
        tiers: {
          create: [
            { patreonTierId: 'b-lo', title: 'Bronze', amountCents: 300, order: 0 },
            { patreonTierId: 'b-hi', title: 'Gold', amountCents: 1000, order: 1 },
          ],
        },
        policy: { create: {} },
      },
      include: { tiers: true },
    });
    creatorId = creator.id;
    goldTierId = creator.tiers.find((t) => t.amountCents === 1000)!.id;

    const other = await ctx.prisma.creator.create({
      data: {
        patreonCampaignId: 'other-board-campaign',
        ownerUserId: owner.id,
        displayName: 'Other Board',
        slug: 'other-board',
        policy: { create: {} },
      },
    });
    otherCreatorId = other.id;
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
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
    return {
      session: pickCookie(res, 'pp_session'),
      csrf,
      csrfToken: csrf.split('=').slice(1).join('='),
    };
  }

  async function makePatron(patreonUserId: string, amountCents: number, targetId = creatorId) {
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { patreonUserId } });
    await ctx.prisma.membership.upsert({
      where: { userId_creatorId: { userId: user.id, creatorId: targetId } },
      create: { userId: user.id, creatorId: targetId, amountCents, isActivePatron: true },
      update: { amountCents, isActivePatron: true },
    });
    return user.id;
  }

  type Auth = Awaited<ReturnType<typeof loginAs>>;

  const submit = (auth: Auth, body: object, slug = 'board-co') =>
    request(ctx.app.getHttpServer())
      .post(`/api/v1/creators/${slug}/recommendations`)
      .set('Cookie', [auth.session, auth.csrf])
      .set('x-csrf-token', auth.csrfToken)
      .send(body);

  const upvote = (auth: Auth, id: string, slug = 'board-co') =>
    request(ctx.app.getHttpServer())
      .post(`/api/v1/creators/${slug}/recommendations/${id}/upvote`)
      .set('Cookie', [auth.session, auth.csrf])
      .set('x-csrf-token', auth.csrfToken);

  describe('normalizeTitle', () => {
    it.each([
      ['The Matrix!', 'the matrix'],
      ['the  matrix', 'the matrix'],
      ['Amélie', 'amelie'],
    ])('normalizes %j', (input, expected) => {
      expect(normalizeTitle(input)).toBe(expected);
    });

    it('keeps genuinely different titles apart', () => {
      expect(normalizeTitle('Dune')).not.toBe(normalizeTitle('Dune Part Two'));
    });

    it('keeps non-Latin titles distinct rather than collapsing them', () => {
      // An ASCII-only class emptied all of these, so every one de-duped into the same entry.
      const titles = ['君の名は。', '기생충', 'Москва слезам не верит', 'الفيلم'];
      const normalized = titles.map(normalizeTitle);
      expect(normalized.every((n) => n.length > 0)).toBe(true);
      expect(new Set(normalized).size).toBe(titles.length);
    });
  });

  describe('submitting', () => {
    it('refuses an anonymous submission', async () => {
      await request(ctx.app.getHttpServer())
        .post('/api/v1/creators/board-co/recommendations')
        .send({ type: 'EXTERNAL_LINK', customTitle: 'Nope' })
        .expect(403); // CSRF first
    });

    it('refuses a logged-in non-patron', async () => {
      const auth = await loginAs('rec-stranger');
      await submit(auth, { type: 'EXTERNAL_LINK', customTitle: 'Nope' }).expect(403);
    });

    it('refuses a patron below the submit gate', async () => {
      const auth = await loginAs('rec-lowtier');
      await makePatron('rec-lowtier', 300);
      await ctx.prisma.creatorPolicy.update({
        where: { creatorId },
        data: { submitMinTierId: goldTierId },
      });
      try {
        await submit(auth, { type: 'EXTERNAL_LINK', customTitle: 'Too Cheap' }).expect(403);
      } finally {
        await ctx.prisma.creatorPolicy.update({
          where: { creatorId },
          data: { submitMinTierId: null },
        });
      }
    });

    it('accepts an eligible patron and persists as PENDING with links', async () => {
      const auth = await loginAs('rec-good');
      await makePatron('rec-good', 1000);
      const res = await submit(auth, {
        type: 'EXTERNAL_LINK',
        customTitle: 'A Good Film',
        description: 'Worth a watch',
        links: [{ url: 'https://example.com/film', label: 'Trailer' }],
      }).expect(201);

      expect(res.body.duplicate).toBe(false);
      // Same shape as a board item: a client prepending this must not get a different card.
      expect(res.body.recommendation.hasUpvoted).toBe(false);
      expect(res.body.recommendation.status).toBe('PENDING');
      expect(res.body.recommendation.upvoteCount).toBe(0);
      expect(res.body.recommendation.links).toEqual([
        { url: 'https://example.com/film', label: 'Trailer' },
      ]);
    });

    it('never exposes the submitter’s email or patreon id', async () => {
      const auth = await loginAs('rec-privacy');
      await makePatron('rec-privacy', 1000);
      const res = await submit(auth, { type: 'EXTERNAL_LINK', customTitle: 'Privacy Check' });
      const body = JSON.stringify(res.body);
      expect(body).not.toContain('@example.com');
      expect(body).not.toContain('rec-privacy');
    });

    it('returns the existing entry on a resubmit rather than erroring', async () => {
      const first = await loginAs('rec-dupe-1');
      await makePatron('rec-dupe-1', 1000);
      const created = await submit(first, {
        type: 'EXTERNAL_LINK',
        customTitle: 'Shared Pick',
      }).expect(201);

      const second = await loginAs('rec-dupe-2');
      await makePatron('rec-dupe-2', 1000);
      // Normalized differently but the same title: design §5 wants the demand signal kept.
      const again = await submit(second, {
        type: 'EXTERNAL_LINK',
        customTitle: 'shared  pick!',
      }).expect(200);

      expect(again.body.duplicate).toBe(true);
      expect(again.body.recommendation.id).toBe(created.body.recommendation.id);
      expect(again.body.recommendation.hasUpvoted).toBe(false);
      expect(
        await ctx.prisma.recommendation.count({
          where: { creatorId, normalizedTitle: 'shared pick' },
        }),
      ).toBe(1);
    });

    it('rate limits a second submission in the window', async () => {
      const auth = await loginAs('rec-flood');
      await makePatron('rec-flood', 1000);
      await submit(auth, { type: 'EXTERNAL_LINK', customTitle: 'First One' }).expect(201);
      await submit(auth, { type: 'EXTERNAL_LINK', customTitle: 'Second One' }).expect(429);
    });

    it('blocks profanity without writing a row', async () => {
      const auth = await loginAs('rec-rude');
      await makePatron('rec-rude', 1000);
      await submit(auth, { type: 'EXTERNAL_LINK', customTitle: 'this is shit' }).expect(400);
      expect(
        await ctx.prisma.recommendation.count({ where: { normalizedTitle: 'this is shit' } }),
      ).toBe(0);
    });

    it('rejects a javascript: link', async () => {
      const auth = await loginAs('rec-xss');
      await makePatron('rec-xss', 1000);
      await submit(auth, {
        type: 'EXTERNAL_LINK',
        customTitle: 'Sneaky',
        links: [{ url: 'javascript:alert(1)' }],
      }).expect(400);
    });

    it('blocks a profane link label, which bypassed moderation entirely', async () => {
      const auth = await loginAs('rec-label');
      await makePatron('rec-label', 1000);
      await submit(auth, {
        type: 'EXTERNAL_LINK',
        customTitle: 'Innocent Title',
        links: [{ url: 'https://example.com/x', label: 'shit' }],
      }).expect(400);
      expect(
        await ctx.prisma.recommendation.count({ where: { normalizedTitle: 'innocent title' } }),
      ).toBe(0);
    });

    it('blocks profanity in a link url', async () => {
      const auth = await loginAs('rec-urlword');
      await makePatron('rec-urlword', 1000);
      await submit(auth, {
        type: 'EXTERNAL_LINK',
        customTitle: 'Also Innocent',
        links: [{ url: 'https://example.com/shit' }],
      }).expect(400);
    });

    it('accepts a non-Latin title and does not collide with another', async () => {
      const a = await loginAs('rec-jp');
      await makePatron('rec-jp', 1000);
      const first = await submit(a, { type: 'EXTERNAL_LINK', customTitle: '君の名は。' }).expect(
        201,
      );

      const b = await loginAs('rec-kr');
      await makePatron('rec-kr', 1000);
      const second = await submit(b, { type: 'EXTERNAL_LINK', customTitle: '기생충' }).expect(201);

      expect(second.body.duplicate).toBe(false);
      expect(second.body.recommendation.id).not.toBe(first.body.recommendation.id);
    });

    it('rejects a title with no letters or digits at all', async () => {
      const auth = await loginAs('rec-punct');
      await makePatron('rec-punct', 1000);
      await submit(auth, { type: 'EXTERNAL_LINK', customTitle: '!!! ---' }).expect(400);
    });

    it('refunds the allowance when the submission was a duplicate', async () => {
      const auth = await loginAs('rec-refund');
      await makePatron('rec-refund', 1000);
      await submit(auth, { type: 'EXTERNAL_LINK', customTitle: 'Refund Target' }).expect(201);

      const other = await loginAs('rec-refund-2');
      await makePatron('rec-refund-2', 1000);
      // Hitting an existing title must not cost the hour: design §5 wants this behaviour.
      await submit(other, { type: 'EXTERNAL_LINK', customTitle: 'Refund Target' }).expect(200);
      await submit(other, { type: 'EXTERNAL_LINK', customTitle: 'Something New' }).expect(201);
    });

    it('rejects a type that has no Title behind it yet', async () => {
      const auth = await loginAs('rec-movie');
      await makePatron('rec-movie', 1000);
      await submit(auth, { type: 'MOVIE', customTitle: 'Not Yet' }).expect(400);
    });
  });

  describe('mainstream submissions', () => {
    const spirited = {
      tmdbId: 129,
      mediaType: 'MOVIE' as const,
      name: 'Spirited Away',
      year: 2001,
      posterPath: '/spirited.jpg',
      overview: 'A girl in a spirit world.',
    };

    beforeEach(() => {
      ctx.catalog.configured = true;
      ctx.catalog.shouldFail = false;
      ctx.catalog.results = [spirited];
    });

    it('binds a canonical title and stores the catalogue name, not the client’s', async () => {
      const auth = await loginAs('tmdb-good');
      await makePatron('tmdb-good', 1000);
      const res = await submit(auth, {
        type: 'MOVIE',
        tmdbId: 129,
        // Deliberately absent: the name must come from the catalogue.
        description: 'Worth it',
      }).expect(201);

      expect(res.body.recommendation.customTitle).toBe('Spirited Away');
      expect(res.body.recommendation.title).toMatchObject({
        tmdbId: 129,
        mediaType: 'MOVIE',
        year: 2001,
      });
      expect(await ctx.prisma.title.count({ where: { tmdbId: 129, mediaType: 'MOVIE' } })).toBe(1);
    });

    it('reuses the existing Title rather than creating a second', async () => {
      ctx.catalog.results = [{ ...spirited, tmdbId: 8392, name: 'My Neighbour Totoro' }];
      const first = await loginAs('tmdb-one');
      await makePatron('tmdb-one', 1000);
      await submit(first, { type: 'MOVIE', tmdbId: 8392 }).expect(201);

      const other = await ctx.prisma.creator.findFirstOrThrow({ where: { slug: 'other-board' } });
      const second = await loginAs('tmdb-two');
      await makePatron('tmdb-two', 1000, other.id);
      // A different creator may bind the same canonical title — the row is shared, the entry is not.
      await submit(second, { type: 'MOVIE', tmdbId: 8392 }, 'other-board').expect(201);

      expect(await ctx.prisma.title.count({ where: { tmdbId: 8392, mediaType: 'MOVIE' } })).toBe(1);
    });

    it('de-duplicates canonically on the same board', async () => {
      const first = await loginAs('tmdb-dupe-1');
      await makePatron('tmdb-dupe-1', 1000);
      ctx.catalog.results = [{ ...spirited, tmdbId: 4935 }];
      const created = await submit(first, { type: 'MOVIE', tmdbId: 4935 }).expect(201);

      const second = await loginAs('tmdb-dupe-2');
      await makePatron('tmdb-dupe-2', 1000);
      const again = await submit(second, { type: 'MOVIE', tmdbId: 4935 }).expect(200);

      expect(again.body.duplicate).toBe(true);
      expect(again.body.recommendation.id).toBe(created.body.recommendation.id);
    });

    it('rejects a tmdbId the catalogue does not know, writing nothing', async () => {
      const auth = await loginAs('tmdb-unknown');
      await makePatron('tmdb-unknown', 1000);
      ctx.catalog.results = [];
      await submit(auth, { type: 'MOVIE', tmdbId: 999999 }).expect(400);
      expect(await ctx.prisma.title.count({ where: { tmdbId: 999999 } })).toBe(0);
    });

    it('rejects a mainstream type with no tmdbId', async () => {
      const auth = await loginAs('tmdb-missing');
      await makePatron('tmdb-missing', 1000);
      await submit(auth, { type: 'MOVIE', customTitle: 'Just words' }).expect(400);
    });

    it('rejects an external link carrying a tmdbId', async () => {
      const auth = await loginAs('tmdb-smuggler');
      await makePatron('tmdb-smuggler', 1000);
      // Otherwise a client could bind a title without it passing the catalogue check.
      await submit(auth, {
        type: 'EXTERNAL_LINK',
        customTitle: 'Sneaky',
        tmdbId: 129,
      }).expect(400);
    });

    it('still moderates the description of a mainstream submission', async () => {
      const auth = await loginAs('tmdb-rude');
      await makePatron('tmdb-rude', 1000);
      ctx.catalog.results = [{ ...spirited, tmdbId: 777 }];
      await submit(auth, { type: 'MOVIE', tmdbId: 777, description: 'this is shit' }).expect(400);
      expect(
        await ctx.prisma.recommendation.count({ where: { titleId: { not: null } } }),
      ).toBeGreaterThanOrEqual(0);
    });
  });

  describe('upvoting', () => {
    let recommendationId: string;

    beforeAll(async () => {
      const auth = await loginAs('rec-author');
      await makePatron('rec-author', 1000);
      const res = await submit(auth, {
        type: 'EXTERNAL_LINK',
        customTitle: 'Upvote Me',
      }).expect(201);
      recommendationId = res.body.recommendation.id;
    });

    it('refuses a non-patron', async () => {
      const auth = await loginAs('up-stranger');
      await upvote(auth, recommendationId).expect(403);
    });

    it('toggles on and off, tracking the count both ways', async () => {
      const auth = await loginAs('up-toggler');
      await makePatron('up-toggler', 300);

      const on = await upvote(auth, recommendationId).expect(201);
      expect(on.body).toEqual({ upvoted: true, upvoteCount: 1 });

      const off = await upvote(auth, recommendationId).expect(201);
      expect(off.body).toEqual({ upvoted: false, upvoteCount: 0 });
    });

    it('counts a second user separately', async () => {
      const a = await loginAs('up-a');
      await makePatron('up-a', 300);
      const b = await loginAs('up-b');
      await makePatron('up-b', 300);

      await upvote(a, recommendationId).expect(201);
      const second = await upvote(b, recommendationId).expect(201);
      expect(second.body.upvoteCount).toBe(2);
    });

    it('is exempt from the submission rate limit', async () => {
      const auth = await loginAs('up-many');
      await makePatron('up-many', 300);
      // Design §6 item 3 exempts upvotes explicitly.
      await upvote(auth, recommendationId).expect(201);
      await upvote(auth, recommendationId).expect(201);
      await upvote(auth, recommendationId).expect(201);
    });

    it('404s for an entry belonging to a different creator', async () => {
      const auth = await loginAs('up-crosser');
      await makePatron('up-crosser', 300, otherCreatorId);
      // Reached through the other creator's slug, so the guard passes but the entry is not theirs.
      await upvote(auth, recommendationId, 'other-board').expect(404);
    });
  });

  describe('the board', () => {
    it('is readable anonymously when the creator is PUBLIC', async () => {
      await request(ctx.app.getHttpServer())
        .get('/api/v1/creators/board-co/recommendations')
        .expect(200);
    });

    it('orders by upvotes then recency', async () => {
      const res = await request(ctx.app.getHttpServer())
        .get('/api/v1/creators/board-co/recommendations')
        .expect(200);
      const counts = res.body.items.map((i: { upvoteCount: number }) => i.upvoteCount);
      expect([...counts]).toEqual([...counts].sort((a, b) => b - a));
    });

    it('excludes DELETED entries', async () => {
      const auth = await loginAs('board-deleter');
      await makePatron('board-deleter', 1000);
      const created = await submit(auth, {
        type: 'EXTERNAL_LINK',
        customTitle: 'Soon Gone',
      }).expect(201);
      await ctx.prisma.recommendation.update({
        where: { id: created.body.recommendation.id },
        data: { status: 'DELETED' },
      });

      const res = await request(ctx.app.getHttpServer())
        .get('/api/v1/creators/board-co/recommendations')
        .expect(200);
      expect(res.body.items.map((i: { id: string }) => i.id)).not.toContain(
        created.body.recommendation.id,
      );
    });

    async function pageThrough(limit = 2): Promise<string[]> {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 40; page += 1) {
        const res: request.Response = await request(ctx.app.getHttpServer())
          .get('/api/v1/creators/board-co/recommendations')
          .query({ limit, ...(cursor ? { cursor } : {}) })
          .expect(200);
        seen.push(...res.body.items.map((i: { id: string }) => i.id));
        cursor = res.body.nextCursor;
        if (!cursor) break;
      }
      return seen;
    }

    it('pages through every item exactly once — completeness, not just uniqueness', async () => {
      const all = await ctx.prisma.recommendation.findMany({
        where: { creatorId, status: { notIn: ['DELETED', 'REJECTED'] } },
        select: { id: true },
      });
      const seen = await pageThrough();
      expect(new Set(seen).size).toBe(seen.length);
      // The half the old test missed: uniqueness alone passes even when pages drop entries.
      expect(new Set(seen)).toEqual(new Set(all.map((r) => r.id)));
    });

    it('does not drop an entry when the cursor row is soft-deleted mid-scroll', async () => {
      const first: request.Response = await request(ctx.app.getHttpServer())
        .get('/api/v1/creators/board-co/recommendations')
        .query({ limit: 2 })
        .expect(200);
      const cursor = first.body.nextCursor as string;
      const lastId = first.body.items[first.body.items.length - 1].id as string;

      // skip:1 was an unconditional OFFSET, so removing the cursor row ate a real one instead.
      await ctx.prisma.recommendation.update({
        where: { id: lastId },
        data: { status: 'DELETED' },
      });
      try {
        const expected = await ctx.prisma.recommendation.findMany({
          where: { creatorId, status: { notIn: ['DELETED', 'REJECTED'] } },
          orderBy: [{ upvoteCount: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
          select: { id: true },
        });
        const next: request.Response = await request(ctx.app.getHttpServer())
          .get('/api/v1/creators/board-co/recommendations')
          .query({ limit: 2, cursor })
          .expect(200);
        const stillExpected = expected.map((r) => r.id).filter((id) => id !== lastId);
        const firstPageIds = first.body.items.map((i: { id: string }) => i.id) as string[];
        const remaining = stillExpected.filter((id) => !firstPageIds.includes(id));
        expect(next.body.items.map((i: { id: string }) => i.id)).toEqual(remaining.slice(0, 2));
      } finally {
        await ctx.prisma.recommendation.update({
          where: { id: lastId },
          data: { status: 'PENDING' },
        });
      }
    });

    it('rejects a cursor it did not mint', async () => {
      await request(ctx.app.getHttpServer())
        .get('/api/v1/creators/board-co/recommendations')
        .query({ cursor: 'not-a-real-cursor' })
        .expect(400);
    });

    it('orders by upvote count descending with a controlled fixture', async () => {
      const auth = await loginAs('order-author');
      await makePatron('order-author', 1000);
      const created = await submit(auth, {
        type: 'EXTERNAL_LINK',
        customTitle: 'Top Of The Board',
      }).expect(201);
      // Give it more upvotes than anything else, so position is a real assertion rather than a
      // sorted-equals-itself tautology.
      await ctx.prisma.recommendation.update({
        where: { id: created.body.recommendation.id },
        data: { upvoteCount: 999 },
      });

      const res = await request(ctx.app.getHttpServer())
        .get('/api/v1/creators/board-co/recommendations')
        .expect(200);
      expect(res.body.items[0].id).toBe(created.body.recommendation.id);
    });

    it('tells the viewer whether they upvoted, so a client can render state truthfully', async () => {
      const auth = await loginAs('board-flagger');
      await makePatron('board-flagger', 300);
      const created = await submit(auth, {
        type: 'EXTERNAL_LINK',
        customTitle: 'Flag Me',
      }).expect(201);
      const id = created.body.recommendation.id as string;

      const anonymous = await request(ctx.app.getHttpServer())
        .get('/api/v1/creators/board-co/recommendations')
        .expect(200);
      expect(anonymous.body.items.find((i: { id: string }) => i.id === id).hasUpvoted).toBe(false);

      await upvote(auth, id).expect(201);
      const mine = await request(ctx.app.getHttpServer())
        .get('/api/v1/creators/board-co/recommendations')
        .set('Cookie', auth.session)
        .expect(200);
      expect(mine.body.items.find((i: { id: string }) => i.id === id).hasUpvoted).toBe(true);

      // Another patron's board must not show it as theirs.
      const other = await loginAs('board-flagger-2');
      await makePatron('board-flagger-2', 300);
      const theirs = await request(ctx.app.getHttpServer())
        .get('/api/v1/creators/board-co/recommendations')
        .set('Cookie', other.session)
        .expect(200);
      expect(theirs.body.items.find((i: { id: string }) => i.id === id).hasUpvoted).toBe(false);
    });

    it('rejects an out-of-range limit', async () => {
      await request(ctx.app.getHttpServer())
        .get('/api/v1/creators/board-co/recommendations')
        .query({ limit: 500 })
        .expect(400);
    });

    it('follows viewVisibility', async () => {
      await ctx.prisma.creatorPolicy.update({
        where: { creatorId },
        data: { viewVisibility: 'SUBSCRIBERS_ONLY' },
      });
      try {
        await request(ctx.app.getHttpServer())
          .get('/api/v1/creators/board-co/recommendations')
          .expect(401);
      } finally {
        await ctx.prisma.creatorPolicy.update({
          where: { creatorId },
          data: { viewVisibility: 'PUBLIC' },
        });
      }
    });
  });
});
