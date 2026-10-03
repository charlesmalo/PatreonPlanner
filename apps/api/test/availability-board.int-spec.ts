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
        policy: { create: { viewVisibility: 'PUBLIC' } },
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
    // Drain first: a refresh queued by the previous test would otherwise upsert a row *after*
    // this delete and leak into the next assertion.
    await ctx.availabilityService.drainRefreshes();
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

  it('refuses a region the deployment does not serve', async () => {
    // Bounded on purpose: an open region set lets one caller create a permanent row, and a
    // permanent refresh obligation, for every country on earth.
    await get(
      `/creators/availability-co/catalog/titles/${titleId}/availability?region=ZZ`,
      patron,
    ).expect(400);
  });

  describe('the reader chooses the region', () => {
    const boardIn = (region: string, auth?: Auth) =>
      get(`/creators/availability-co/recommendations?limit=50&region=${region}`, auth);

    it('answers the board in the region the reader asked for', async () => {
      // The whole point: availability used to be answered for one region server-wide, so a
      // patron in Britain read "Where to watch (US)" and a list of American offers.
      await boardIn('GB', patron).expect(200);
      await ctx.availabilityService.drainRefreshes();

      const res = await boardIn('GB', patron).expect(200);
      const bound = res.body.items.find((i: { id: string }) => i.id === boundId);
      expect(bound.availability.region).toBe('GB');
    });

    it('answers an entry page in the same region', async () => {
      // A board card and the entry's own page are the same question about the same entry. They
      // diverged once already — findOne had its own availability path — so this is asserted
      // rather than assumed.
      await get(`/creators/availability-co/recommendations/${boundId}?region=GB`, patron).expect(
        200,
      );
      await ctx.availabilityService.drainRefreshes();

      const res = await get(
        `/creators/availability-co/recommendations/${boundId}?region=GB`,
        patron,
      ).expect(200);
      expect(res.body.availability.region).toBe('GB');
    });

    it('still defaults when the reader asks for nothing', async () => {
      await board(patron).expect(200);
      await ctx.availabilityService.drainRefreshes();

      const res = await board(patron).expect(200);
      const bound = res.body.items.find((i: { id: string }) => i.id === boundId);
      expect(bound.availability.region).toBe('US');
    });

    it('refuses a region the deployment does not serve, rather than dropping the badges', async () => {
      // The trap this guards. Both availability lookups swallow their own errors — badges are
      // garnish and a cold provider must not 500 a board — so a region check *inside* that
      // try/catch would be swallowed too, and the reader would get a board with no badges and
      // no reason. 400 is the honest answer, and it has to be given before the swallowing.
      await boardIn('ZZ', patron).expect(400);
      await get(`/creators/availability-co/recommendations/${boundId}?region=ZZ`, patron).expect(
        400,
      );
    });

    it('rejects a malformed region on the board too', async () => {
      await boardIn('GBR', patron).expect(400);
      await boardIn('gb', patron).expect(400);
    });

    it('lists the regions it serves, and which is the default', async () => {
      // A route rather than a constant in the client: the set is deployment configuration, and a
      // hardcoded copy drifts the moment an operator edits it — leaving a reader able to pick a
      // country the server refuses, which reads as a broken setting.
      const res = await get('/meta/regions').expect(200);

      expect(res.body.regions).toContain('US');
      expect(res.body.regions).toContain('GB');
      expect(res.body.default).toBe('US');
    });

    it('offers the region list without a session', async () => {
      // Availability is shown to signed-out readers, so the control that changes it must work
      // for them. It exposes nothing but country codes an operator chose.
      await get('/meta/regions').expect(200);
    });
  });

  it('exposes the catalogue id the availability endpoint keys on', async () => {
    // Without it the endpoint is unreachable: no response anywhere carried the title's id.
    const res = await board(patron).expect(200);
    const bound = res.body.items.find((i: { id: string }) => i.id === boundId);
    expect(bound.title.id).toBe(titleId);
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

  it('attaches availability to an entry on its own page', async () => {
    // The same entry, the same question. A board card said where to watch and the entry's own
    // page — the URL a patron is sent — said nothing, because findOne returned
    // BOARD_ONLY_DEFAULTS, where `availability: null` means "not looked up" and is the right
    // answer for a fresh submission and the wrong one here.
    await board(patron).expect(200);
    await ctx.availabilityService.drainRefreshes();

    const res = await get(`/creators/availability-co/recommendations/${boundId}`, patron).expect(
      200,
    );
    expect(res.body.availability.offers[0].providerName).toBe('Netflix');
  });

  it('does not make an entry page wait on the provider either', async () => {
    // Same bargain the board makes: a cold read renders without badges rather than blocking on
    // a third party, and queues the refresh that the next read serves.
    const res = await get(`/creators/availability-co/recommendations/${boundId}`, patron).expect(
      200,
    );
    expect(res.body.availability).toBeNull();
  });

  it('leaves an external-link entry null on its own page', async () => {
    await board(patron).expect(200);
    await ctx.availabilityService.drainRefreshes();

    const res = await get(`/creators/availability-co/recommendations/${unboundId}`, patron).expect(
      200,
    );
    expect(res.body.availability).toBeNull();
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
