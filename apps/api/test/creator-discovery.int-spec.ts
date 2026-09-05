import request from 'supertest';
import { AuthTestContext, pickCookie, startAuthApp } from './support/auth-app';

describe('Creator discovery (integration)', () => {
  let ctx: AuthTestContext;
  let patron: Auth;
  let patronUserId: string;
  let ids: Record<string, string> = {};

  beforeAll(async () => {
    ctx = await startAuthApp();
    const owner = await ctx.prisma.user.create({ data: { patreonUserId: 'cd-owner' } });
    // Names chosen so one query matches several: ranking is the thing worth testing, and a query
    // that matches exactly one board proves nothing about it.
    for (const [key, displayName, slug] of [
      ['subscribed', 'Movie Night With Ada', 'movie-night-ada'],
      ['favourited', 'Movie Club Weekly', 'movie-club-weekly'],
      ['stranger', 'Movie Marathon Hour', 'movie-marathon'],
      ['unrelated', 'Book Corner', 'book-corner'],
    ] as const) {
      ids[key] = (
        await ctx.prisma.creator.create({
          data: {
            patreonCampaignId: `cd-${key}`,
            ownerUserId: owner.id,
            displayName,
            slug,
            policy: { create: { viewVisibility: 'PUBLIC' } },
            staff: { create: { userId: owner.id, role: 'OWNER' } },
          },
        })
      ).id;
    }

    patron = await loginAs('cd-patron');
    patronUserId = (
      await ctx.prisma.user.findUniqueOrThrow({ where: { patreonUserId: 'cd-patron' } })
    ).id;
    await ctx.prisma.membership.create({
      data: {
        userId: patronUserId,
        creatorId: ids.subscribed,
        amountCents: 500,
        isActivePatron: true,
      },
    });
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.prisma.creatorFavorite.deleteMany();
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

  type Auth = Awaited<ReturnType<typeof loginAs>>;

  const search = (q: string, auth?: Auth) => {
    const req = request(ctx.app.getHttpServer()).get(`/api/v1/creators?q=${encodeURIComponent(q)}`);
    return auth ? req.set('Cookie', [auth.session, auth.csrf]) : req;
  };

  const favourite = (auth: Auth, slug: string, method: 'post' | 'delete' = 'post') =>
    request(ctx.app.getHttpServer())
      [method](`/api/v1/creators/${slug}/favorite`)
      .set('Cookie', [auth.session, auth.csrf])
      .set('x-csrf-token', auth.csrfToken);

  const names = (body: { items: Array<{ displayName: string }> }) =>
    body.items.map((item) => item.displayName);

  it('finds a board by name', async () => {
    const res = await search('marathon').expect(200);

    expect(names(res.body)).toEqual(['Movie Marathon Hour']);
  });

  it('finds a board by slug, since that is what people paste', async () => {
    const res = await search('book-corner').expect(200);

    expect(names(res.body)).toEqual(['Book Corner']);
  });

  it('ignores case', async () => {
    const res = await search('BOOK').expect(200);

    expect(names(res.body)).toEqual(['Book Corner']);
  });

  it('returns nothing for a query that matches nothing', async () => {
    const res = await search('nothing at all like this').expect(200);

    expect(res.body.items).toEqual([]);
  });

  it('serves a signed-out reader, since boards are public', async () => {
    const res = await search('movie').expect(200);

    expect(names(res.body)).toHaveLength(3);
  });

  describe('ranking', () => {
    it('puts a board the reader supports above a stranger', async () => {
      const res = await search('movie', patron).expect(200);

      expect(names(res.body)[0]).toBe('Movie Night With Ada');
    });

    it('puts a favourite above everything, including one they support', async () => {
      // Favouriting is a deliberate act; a membership is a side effect of paying for something.
      await favourite(patron, 'movie-club-weekly').expect(204);

      const res = await search('movie', patron).expect(200);

      expect(names(res.body).slice(0, 2)).toEqual(['Movie Club Weekly', 'Movie Night With Ada']);
    });

    it('tells the reader which ones are which', async () => {
      await favourite(patron, 'movie-club-weekly').expect(204);

      const res = await search('movie', patron).expect(200);

      const club = res.body.items.find(
        (item: { slug: string }) => item.slug === 'movie-club-weekly',
      );
      const stranger = res.body.items.find(
        (item: { slug: string }) => item.slug === 'movie-marathon',
      );
      expect(club).toMatchObject({ favorited: true, supported: false });
      expect(stranger).toMatchObject({ favorited: false, supported: false });
    });

    it('shows a signed-out reader no favourites of anyone else', async () => {
      await favourite(patron, 'movie-club-weekly').expect(204);

      const res = await search('movie').expect(200);

      expect(res.body.items.every((item: { favorited: boolean }) => item.favorited === false)).toBe(
        true,
      );
    });
  });

  describe('favouriting', () => {
    it('needs a session', async () => {
      // With a CSRF token but no session, so this reaches the session guard rather than being
      // turned away by the CSRF middleware first — otherwise the test passes on the wrong 403.
      const visit = await request(ctx.app.getHttpServer()).get('/api/v1/creators?q=movie');
      const csrf = pickCookie(visit, 'pp_csrf').split(';')[0];

      await request(ctx.app.getHttpServer())
        .post('/api/v1/creators/movie-marathon/favorite')
        .set('Cookie', [csrf])
        .set('x-csrf-token', csrf.split('=').slice(1).join('='))
        .expect(401);
    });

    it('is idempotent, so a double click is not an error', async () => {
      await favourite(patron, 'movie-marathon').expect(204);
      await favourite(patron, 'movie-marathon').expect(204);

      expect(await ctx.prisma.creatorFavorite.count({ where: { userId: patronUserId } })).toBe(1);
    });

    it('can be undone', async () => {
      await favourite(patron, 'movie-marathon').expect(204);

      await favourite(patron, 'movie-marathon', 'delete').expect(204);

      expect(await ctx.prisma.creatorFavorite.count({ where: { userId: patronUserId } })).toBe(0);
    });

    it('404s an unknown board rather than storing a favourite for nothing', async () => {
      await favourite(patron, 'no-such-board').expect(404);
    });

    it('never removes another reader favourite', async () => {
      const other = await loginAs('cd-other');
      await favourite(patron, 'movie-marathon').expect(204);

      await favourite(other, 'movie-marathon', 'delete').expect(204);

      expect(await ctx.prisma.creatorFavorite.count({ where: { userId: patronUserId } })).toBe(1);
    });
  });
});
