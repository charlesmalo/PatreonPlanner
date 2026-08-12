import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AuthTestContext, pickCookie, startAuthApp } from './support/auth-app';

describe('Availability on the board (integration)', () => {
  let ctx: AuthTestContext;
  let creatorId: string;
  let patron: Auth;
  let patronUserId: string;
  let titleId: string;
  let boundId: string;
  let unboundId: string;

  beforeAll(async () => {
    ctx = await startAuthApp();
    const owner = await ctx.prisma.user.create({ data: { patreonUserId: 'av-owner' } });
    const creator = await ctx.prisma.creator.create({
      data: {
        patreonCampaignId: 'av-campaign',
        ownerUserId: owner.id,
        displayName: 'Availability Co',
        slug: 'availability-co',
        policy: { create: {} },
      },
    });
    creatorId = creator.id;

    patron = await loginAs('av-patron');
    patronUserId = (
      await ctx.prisma.user.findUniqueOrThrow({ where: { patreonUserId: 'av-patron' } })
    ).id;
    await ctx.prisma.membership.create({
      data: { userId: patronUserId, creatorId, amountCents: 500, isActivePatron: true },
    });

    titleId = (
      await ctx.prisma.title.create({
        data: { tmdbId: 129, mediaType: 'MOVIE', name: 'Spirited Away' },
      })
    ).id;

    boundId = (
      await ctx.prisma.recommendation.create({
        data: {
          creatorId,
          submittedByUserId: patronUserId,
          type: 'MOVIE',
          customTitle: 'Spirited Away',
          normalizedTitle: 'spirited away',
          titleId,
        },
      })
    ).id;
    unboundId = (
      await ctx.prisma.recommendation.create({
        data: {
          creatorId,
          submittedByUserId: patronUserId,
          type: 'EXTERNAL_LINK',
          customTitle: 'A blog post',
          normalizedTitle: 'a blog post',
        },
      })
    ).id;
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.prisma.streamingAvailability.deleteMany();
    ctx.availability.reset();
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

  const get = (path: string, auth?: Auth) => {
    const req = request(ctx.app.getHttpServer()).get(`/api/v1${path}`);
    return auth ? req.set('Cookie', [auth.session, auth.csrf]) : req;
  };

  const board = (auth?: Auth) => get('/creators/availability-co/recommendations?limit=50', auth);

  it('returns availability for a catalogue title', async () => {
    const res = await get(
      `/creators/availability-co/catalog/titles/${titleId}/availability?region=GB`,
      patron,
    ).expect(200);
    expect(res.body.region).toBe('GB');
    expect(res.body.offers[0].providerName).toBe('Netflix');
  });

  it('defaults to the configured region', async () => {
    const res = await get(
      `/creators/availability-co/catalog/titles/${titleId}/availability`,
      patron,
    ).expect(200);
    expect(res.body.region).toBe('US');
  });

  it('rejects a malformed region', async () => {
    await get(
      `/creators/availability-co/catalog/titles/${titleId}/availability?region=GBR`,
      patron,
    ).expect(400);
  });

  it('404s an unknown title', async () => {
    await get(
      `/creators/availability-co/catalog/titles/${randomUUID()}/availability`,
      patron,
    ).expect(404);
  });

  it('refuses a viewer who cannot see the board', async () => {
    await ctx.prisma.creatorPolicy.update({
      where: { creatorId },
      data: { viewVisibility: 'SUBSCRIBERS_ONLY' },
    });
    await get(`/creators/availability-co/catalog/titles/${titleId}/availability`).expect(401);
    await ctx.prisma.creatorPolicy.update({
      where: { creatorId },
      data: { viewVisibility: 'PUBLIC' },
    });
  });

  it('attaches availability to board entries bound to a title', async () => {
    // The board never blocks on the provider, so the first read has nothing and the second has
    // the answer the first one queued.
    await board(patron).expect(200);
    await ctx.availabilityService.drainRefreshes();

    const res = await board(patron).expect(200);
    const bound = res.body.items.find((i: { id: string }) => i.id === boundId);
    expect(bound.availability.offers[0].providerName).toBe('Netflix');
  });

  it('leaves external-link entries with null availability', async () => {
    // Nothing to look up: an external link has no canonical identity.
    const res = await board(patron).expect(200);
    const unbound = res.body.items.find((i: { id: string }) => i.id === unboundId);
    expect(unbound.availability).toBeNull();
  });

  it('renders the board when availability is unavailable', async () => {
    // The whole point of degrading: no key, no badges, still a board.
    ctx.availability.configured = false;
    const res = await board(patron).expect(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    expect(res.body.items.every((i: { availability: unknown }) => i.availability === null)).toBe(
      true,
    );
  });

  it('does not make a board read wait on the provider', async () => {
    // A first read of a cold board returns immediately with no badges rather than blocking.
    const res = await board(patron).expect(200);
    const bound = res.body.items.find((i: { id: string }) => i.id === boundId);
    expect(bound.availability).toBeNull();
  });
});
