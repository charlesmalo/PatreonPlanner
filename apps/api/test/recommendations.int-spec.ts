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

    it('rejects a type that has no Title behind it yet', async () => {
      const auth = await loginAs('rec-movie');
      await makePatron('rec-movie', 1000);
      await submit(auth, { type: 'MOVIE', customTitle: 'Not Yet' }).expect(400);
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

    it('pages with a cursor, returning each item exactly once', async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page += 1) {
        const res: request.Response = await request(ctx.app.getHttpServer())
          .get('/api/v1/creators/board-co/recommendations')
          .query({ limit: 2, ...(cursor ? { cursor } : {}) })
          .expect(200);
        seen.push(...res.body.items.map((i: { id: string }) => i.id));
        cursor = res.body.nextCursor;
        if (!cursor) break;
      }
      expect(new Set(seen).size).toBe(seen.length);
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
