import request from 'supertest';
import { AuthTestContext, pickCookie, startAuthApp } from './support/auth-app';

describe('Catalogue search (integration)', () => {
  let ctx: AuthTestContext;
  let creatorId: string;

  beforeAll(async () => {
    ctx = await startAuthApp();
    const owner = await ctx.prisma.user.create({ data: { patreonUserId: 'cat-owner' } });
    const creator = await ctx.prisma.creator.create({
      data: {
        patreonCampaignId: 'cat-campaign',
        ownerUserId: owner.id,
        displayName: 'Cat Co',
        slug: 'cat-co',
        policy: { create: { viewVisibility: 'PUBLIC' } },
      },
    });
    creatorId = creator.id;
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(() => {
    ctx.catalog.configured = true;
    ctx.catalog.shouldFail = false;
    ctx.catalog.searchCalls = [];
    ctx.catalog.results = [
      {
        tmdbId: 129,
        mediaType: 'MOVIE',
        name: 'Spirited Away',
        year: 2001,
        posterPath: '/poster.jpg',
        overview: 'A girl in a spirit world.',
      },
    ];
  });

  async function loginAs(patreonUserId: string, patron = true) {
    ctx.patreon.identity = { ...ctx.patreon.identity, patreonUserId, memberships: [] };
    const start = await request(ctx.app.getHttpServer()).get('/auth/patreon/login').expect(302);
    const state = new URL(start.headers.location).searchParams.get('state') as string;
    const res = await request(ctx.app.getHttpServer())
      .get(`/auth/patreon/callback?code=auth-code&state=${state}`)
      .set('Cookie', pickCookie(start, 'pp_oauth_state'))
      .expect(302);
    if (patron) {
      const user = await ctx.prisma.user.findUniqueOrThrow({ where: { patreonUserId } });
      await ctx.prisma.membership.upsert({
        where: { userId_creatorId: { userId: user.id, creatorId } },
        create: { userId: user.id, creatorId, amountCents: 500, isActivePatron: true },
        update: { isActivePatron: true },
      });
    }
    return pickCookie(res, 'pp_session');
  }

  const search = (cookie: string | null, q: string) => {
    const req = request(ctx.app.getHttpServer())
      .get('/api/v1/creators/cat-co/catalog/search')
      .query({ q });
    return cookie ? req.set('Cookie', cookie) : req;
  };

  it('refuses a viewer who cannot submit', async () => {
    // Gated on SUBMIT, not VIEW: it feeds the submit form and spends a third-party quota.
    await search(await loginAs('cat-lurker', false), 'spirited').expect(403);
  });

  it('returns results for a patron', async () => {
    const res = await search(await loginAs('cat-patron'), 'spirited').expect(200);
    expect(res.body.results[0]).toMatchObject({ tmdbId: 129, name: 'Spirited Away', year: 2001 });
  });

  it('serves a repeat search from cache without calling the provider again', async () => {
    const cookie = await loginAs('cat-cacher');
    await search(cookie, 'totoro').expect(200);
    await search(cookie, 'totoro').expect(200);
    expect(ctx.catalog.searchCalls).toHaveLength(1);
  });

  it('normalises the query so trivial differences share a cache entry', async () => {
    const cookie = await loginAs('cat-normal');
    await search(cookie, 'Princess Mononoke').expect(200);
    await search(cookie, '  princess   mononoke ').expect(200);
    expect(ctx.catalog.searchCalls).toHaveLength(1);
  });

  it('caches distinct queries separately', async () => {
    const cookie = await loginAs('cat-distinct');
    await search(cookie, 'akira').expect(200);
    await search(cookie, 'ghost in the shell').expect(200);
    expect(ctx.catalog.searchCalls).toHaveLength(2);
  });

  it('rejects a query too short to be a search', async () => {
    const cookie = await loginAs('cat-short');
    await search(cookie, 'a').expect(400);
    expect(ctx.catalog.searchCalls).toHaveLength(0);
  });

  it('reports an upstream failure as 502, not 500', async () => {
    const cookie = await loginAs('cat-broken');
    ctx.catalog.shouldFail = true;
    await search(cookie, 'anything at all').expect(502);
  });

  it('degrades to 503 when no key is configured', async () => {
    const cookie = await loginAs('cat-unconfigured');
    ctx.catalog.configured = false;
    // EXTERNAL_LINK submissions keep working; only the mainstream path is unavailable.
    await search(cookie, 'unconfigured query').expect(503);
  });
});
