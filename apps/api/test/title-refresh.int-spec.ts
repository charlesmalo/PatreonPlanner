import request from 'supertest';
import { AuthTestContext, pickCookie, startAuthApp } from './support/auth-app';

/**
 * What a second binding refreshes on a catalogue title.
 *
 * The upsert's `update` branch says "Refreshed on each binding: posters and overviews change
 * upstream" and refreshed the poster and not the overview. A title first bound before its
 * overview existed upstream kept a null one for ever — and the overview is what the embedding is
 * computed from, so semantic search stayed as weak as it was on the day the title first appeared.
 */
describe('Rebinding a catalogue title (integration)', () => {
  let ctx: AuthTestContext;
  let creatorId: string;

  beforeAll(async () => {
    ctx = await startAuthApp();
    const owner = await ctx.prisma.user.create({ data: { patreonUserId: 'refresh-owner' } });
    const creator = await ctx.prisma.creator.create({
      data: {
        patreonCampaignId: 'refresh-campaign',
        ownerUserId: owner.id,
        displayName: 'Refresh Co',
        slug: 'refresh-co',
        policy: { create: { viewVisibility: 'PUBLIC' } },
      },
      select: { id: true },
    });
    creatorId = creator.id;
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
  });

  async function loginAs(patreonUserId: string) {
    ctx.patreon.identity = {
      ...ctx.patreon.identity,
      patreonUserId,
      memberships: [
        {
          campaignId: 'refresh-campaign',
          patreonTierIds: [],
          amountCents: 1000,
          isActivePatron: true,
        },
      ],
    };
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

  // A MOVIE binds by tmdbId alone; `customTitle` belongs to the types that have no upstream
  // identity, and sending both is rejected.
  // 201 when the suggestion is new, 200 when it is deduplicated into an existing one. Which
  // happens depends on who has already suggested it, and is not what these tests are about —
  // what matters is that the binding ran.
  const suggest = async (auth: { session: string; csrf: string; csrfToken: string }) => {
    const res = await request(ctx.app.getHttpServer())
      .post('/api/v1/creators/refresh-co/recommendations')
      .set('Cookie', [auth.session, auth.csrf])
      .set('x-csrf-token', auth.csrfToken)
      .send({ type: 'MOVIE', tmdbId: 4242 });
    expect([200, 201]).toContain(res.status);
    return res;
  };

  it('refreshes the overview, not only the poster', async () => {
    const auth = await loginAs('refresh-patron');
    // First binding: upstream knows the title and nothing else about it yet.
    ctx.catalog.results = [
      {
        tmdbId: 4242,
        mediaType: 'MOVIE',
        name: 'Late Bloomer',
        year: 2020,
        posterPath: null,
        overview: null,
      },
    ];
    await suggest(auth);

    const first = await ctx.prisma.title.findFirstOrThrow({ where: { tmdbId: 4242 } });
    expect(first.overview).toBeNull();

    // Upstream fills both in. A second binding is the only moment we look again.
    ctx.catalog.results = [
      {
        tmdbId: 4242,
        mediaType: 'MOVIE',
        name: 'Late Bloomer',
        year: 2020,
        posterPath: '/late.jpg',
        overview: 'A gardener discovers something under the greenhouse.',
      },
    ];
    const second = await loginAs('refresh-patron-two');
    await suggest(second);

    const after = await ctx.prisma.title.findFirstOrThrow({ where: { tmdbId: 4242 } });
    expect(after.posterPath).toBe('/late.jpg');
    // The one the comment promised and the code did not do.
    expect(after.overview).toBe('A gardener discovers something under the greenhouse.');
  });

  it('clears the embedding when the overview changes, so it is recomputed', async () => {
    // The embedding is derived from this text. Leaving a stale vector attached to changed text is
    // worse than having none: search would keep answering from a description nobody can read any
    // more, and nothing would look wrong.
    const auth = await loginAs('refresh-patron-three');
    ctx.catalog.results = [
      {
        tmdbId: 4242,
        mediaType: 'MOVIE',
        name: 'Late Bloomer',
        year: 2020,
        posterPath: '/late.jpg',
        overview: 'A gardener discovers something under the greenhouse.',
      },
    ];
    await ctx.prisma.$executeRawUnsafe(
      `UPDATE "Title" SET embedding = $1::vector, "embeddingModel" = 'test' WHERE "tmdbId" = 4242`,
      `[${Array.from({ length: 384 }, () => 0.1).join(',')}]`,
    );

    ctx.catalog.results = [
      {
        tmdbId: 4242,
        mediaType: 'MOVIE',
        name: 'Late Bloomer',
        year: 2020,
        posterPath: '/late.jpg',
        overview: 'Entirely different words about an entirely different film.',
      },
    ];
    await suggest(auth);

    const rows = await ctx.prisma.$queryRawUnsafe<Array<{ has: boolean }>>(
      `SELECT embedding IS NOT NULL AS has FROM "Title" WHERE "tmdbId" = 4242`,
    );
    expect(rows[0].has).toBe(false);
  });
});
