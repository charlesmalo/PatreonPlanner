import request from 'supertest';
import { AuthTestContext, pickCookie, startAuthApp } from './support/auth-app';

describe('Franchise and watch-order submissions (integration)', () => {
  let ctx: AuthTestContext;
  let creatorId: string;
  let patron: Auth;
  let staff: Auth;

  beforeAll(async () => {
    // This suite submits many times as the same patron. The limiter is exercised by its own
    // suite; here it would only make every test after the first a 429.
    process.env.SUBMIT_LIMIT_PER_HOUR = '1000';
    process.env.SUBMIT_LIMIT_PER_HOUR_GLOBAL = '1000';
    ctx = await startAuthApp();
    const owner = await ctx.prisma.user.create({ data: { patreonUserId: 'cc-owner' } });
    const creator = await ctx.prisma.creator.create({
      data: {
        patreonCampaignId: 'cc-campaign',
        ownerUserId: owner.id,
        displayName: 'Classes Co',
        slug: 'classes-co',
        policy: { create: {} },
      },
    });
    creatorId = creator.id;

    patron = await loginAs('cc-patron');
    await makePatron('cc-patron');
    staff = await loginAs('cc-staff');
    const staffUser = await ctx.prisma.user.findUniqueOrThrow({
      where: { patreonUserId: 'cc-staff' },
    });
    await ctx.prisma.creatorStaff.create({
      data: { creatorId, userId: staffUser.id, role: 'MOD' },
    });
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.prisma.recommendation.deleteMany({ where: { creatorId } });
    ctx.catalog.results = [
      {
        tmdbId: 129,
        mediaType: 'MOVIE',
        name: 'Spirited Away',
        year: 2001,
        posterPath: null,
        overview: null,
      },
      {
        tmdbId: 10,
        mediaType: 'COLLECTION',
        name: 'Star Wars Collection',
        year: null,
        posterPath: '/sw.jpg',
        overview: null,
      },
      {
        tmdbId: 10,
        mediaType: 'MOVIE',
        name: 'Star Wars: A New Hope',
        year: 1977,
        posterPath: null,
        overview: null,
      },
    ];
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

  async function makePatron(patreonUserId: string) {
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { patreonUserId } });
    await ctx.prisma.membership.upsert({
      where: { userId_creatorId: { userId: user.id, creatorId } },
      create: { userId: user.id, creatorId, amountCents: 500, isActivePatron: true },
      update: { amountCents: 500, isActivePatron: true },
    });
  }

  type Auth = Awaited<ReturnType<typeof loginAs>>;

  const submit = (auth: Auth, body: object) =>
    request(ctx.app.getHttpServer())
      .post('/api/v1/creators/classes-co/recommendations')
      .set('Cookie', [auth.session, auth.csrf])
      .set('x-csrf-token', auth.csrfToken)
      .send(body);

  const board = (auth: Auth) =>
    request(ctx.app.getHttpServer())
      .get('/api/v1/creators/classes-co/recommendations?limit=50')
      .set('Cookie', [auth.session, auth.csrf]);

  const countEntries = () => ctx.prisma.recommendation.count({ where: { creatorId } });

  describe('franchises', () => {
    it('binds a franchise to a TMDB collection', async () => {
      const res = await submit(patron, { type: 'FRANCHISE', tmdbId: 10 }).expect(201);
      expect(res.body.recommendation.customTitle).toBe('Star Wars Collection');
      expect(res.body.recommendation.title.mediaType).toBe('COLLECTION');
    });

    it('rejects a franchise TMDB does not know', async () => {
      await submit(patron, { type: 'FRANCHISE', tmdbId: 999999 }).expect(400);
      expect(await countEntries()).toBe(0);
    });

    it('de-duplicates a franchise against the same collection', async () => {
      await submit(patron, { type: 'FRANCHISE', tmdbId: 10 }).expect(201);
      const res = await submit(staff, { type: 'FRANCHISE', tmdbId: 10 }).expect(200);
      expect(res.body.duplicate).toBe(true);
      expect(await countEntries()).toBe(1);
    });

    it('keeps a franchise distinct from a film with the same TMDB id', async () => {
      // TMDB ids are unique only within a media type, so both must be able to exist.
      await submit(patron, { type: 'MOVIE', tmdbId: 10 }).expect(201);
      await submit(staff, { type: 'FRANCHISE', tmdbId: 10 }).expect(201);
      expect(await countEntries()).toBe(2);
    });

    it('refuses a customTitle on a franchise', async () => {
      await submit(patron, { type: 'FRANCHISE', tmdbId: 10, customTitle: 'Mine' }).expect(400);
    });

    it('refuses a franchise with no tmdbId', async () => {
      await submit(patron, { type: 'FRANCHISE' }).expect(400);
    });
  });

  describe('watch orders', () => {
    const order = (items: object[], customTitle = 'Chronological Star Wars') => ({
      type: 'WATCH_ORDER',
      customTitle,
      items,
    });

    it('stores items in the order they were sent', async () => {
      const res = await submit(
        patron,
        order([{ customTitle: 'The Phantom Menace' }, { customTitle: 'Attack of the Clones' }]),
      ).expect(201);
      const items = res.body.recommendation.watchOrderItems;
      expect(items.map((i: { customTitle: string }) => i.customTitle)).toEqual([
        'The Phantom Menace',
        'Attack of the Clones',
      ]);
      // Numbered by the server, not by the client.
      expect(items.map((i: { position: number }) => i.position)).toEqual([0, 1]);
    });

    it('binds an item to the catalogue when it carries a tmdbId', async () => {
      const res = await submit(
        patron,
        order([{ tmdbId: 129, mediaType: 'MOVIE' }, { customTitle: 'A fan edit' }]),
      ).expect(201);
      const items = res.body.recommendation.watchOrderItems;
      expect(items[0].title.name).toBe('Spirited Away');
      expect(items[1].title).toBeNull();
    });

    it('requires at least one item', async () => {
      await submit(patron, order([])).expect(400);
    });

    it('caps a watch order at fifty items', async () => {
      const items = Array.from({ length: 51 }, (_unused, i) => ({ customTitle: `Item ${i}` }));
      await submit(patron, order(items)).expect(400);
      expect(await countEntries()).toBe(0);
    });

    it('refuses an item that is neither bound nor titled', async () => {
      await submit(patron, order([{ note: 'hm' }])).expect(400);
    });

    it('refuses an item that is both bound and titled', async () => {
      await submit(
        patron,
        order([{ tmdbId: 129, mediaType: 'MOVIE', customTitle: 'Mine' }]),
      ).expect(400);
    });

    it('moderates item titles', async () => {
      // Design §6.5 puts every user string through the pipeline; item text is exactly where a
      // submitter would route around a title-only check.
      await submit(patron, order([{ customTitle: 'this is shit' }])).expect(400);
      expect(await countEntries()).toBe(0);
    });

    it('moderates item notes', async () => {
      await submit(patron, order([{ customTitle: 'ok', note: 'this is shit' }])).expect(400);
      expect(await countEntries()).toBe(0);
    });

    it('rejects an unknown tmdbId on an item without persisting the entry', async () => {
      await submit(patron, order([{ tmdbId: 999999, mediaType: 'MOVIE' }])).expect(400);
      expect(await countEntries()).toBe(0);
    });

    it('rejects items on a type that cannot have them', async () => {
      await submit(patron, {
        type: 'MOVIE',
        tmdbId: 129,
        items: [{ customTitle: 'x' }],
      }).expect(400);
    });

    it('does not collide with an external link of the same name', async () => {
      // The unbound de-dupe index had no `type`, so a watch order named like an existing link
      // resolved to that link: the steps were silently discarded and a link card came back.
      await submit(patron, {
        type: 'EXTERNAL_LINK',
        customTitle: 'Star Wars Marathon',
        links: [{ url: 'https://example.invalid/marathon' }],
      }).expect(201);

      const res = await submit(staff, order([{ customTitle: 'One' }], 'Star Wars Marathon')).expect(
        201,
      );
      expect(res.body.recommendation.type).toBe('WATCH_ORDER');
      expect(res.body.recommendation.watchOrderItems).toHaveLength(1);
      expect(await countEntries()).toBe(2);
    });

    it('validates items even when the submission is a duplicate', async () => {
      // The same body was a 400 with a fresh name and a 200 with a taken one, because the
      // de-dupe read returned before items were ever looked at.
      await submit(patron, order([{ customTitle: 'One' }])).expect(201);
      await submit(staff, order([{ note: 'no title' }])).expect(400);
    });

    it('requires a media type alongside a catalogue id', async () => {
      // TMDB ids are unique only within a media type; defaulting to MOVIE silently bound film
      // 1399 for someone who meant series 1399.
      await submit(patron, order([{ tmdbId: 129 }])).expect(400);
    });

    it('refuses a step whose title is only whitespace', async () => {
      await submit(patron, order([{ customTitle: '   ' }])).expect(400);
    });

    it('de-duplicates on the outer title like an external link does', async () => {
      await submit(patron, order([{ customTitle: 'A' }])).expect(201);
      const res = await submit(staff, order([{ customTitle: 'B' }])).expect(200);
      expect(res.body.duplicate).toBe(true);
    });
  });

  describe('reading them back', () => {
    it('returns watch-order items in position order on the board', async () => {
      await submit(patron, {
        type: 'WATCH_ORDER',
        customTitle: 'Order',
        items: [{ customTitle: 'One' }, { customTitle: 'Two' }, { customTitle: 'Three' }],
      }).expect(201);

      const res = await board(patron).expect(200);
      const entry = res.body.items.find((i: { type: string }) => i.type === 'WATCH_ORDER');
      expect(entry.watchOrderItems.map((i: { customTitle: string }) => i.customTitle)).toEqual([
        'One',
        'Two',
        'Three',
      ]);
    });

    it('gives types that cannot have items an empty array', async () => {
      await submit(patron, { type: 'MOVIE', tmdbId: 129 }).expect(201);
      const res = await board(patron).expect(200);
      const movie = res.body.items.find((i: { type: string }) => i.type === 'MOVIE');
      expect(movie.watchOrderItems).toEqual([]);
    });

    it('shows a moderator the items so they can be reviewed', async () => {
      // A watch order's text is mostly *in* its items; a queue that hid them would be reviewing
      // a title and nothing else.
      await submit(patron, {
        type: 'WATCH_ORDER',
        customTitle: 'Order',
        items: [{ customTitle: 'One', note: 'start here' }],
      }).expect(201);

      const res = await request(ctx.app.getHttpServer())
        .get('/api/v1/creators/classes-co/review-queue')
        .set('Cookie', [staff.session, staff.csrf])
        .expect(200);
      expect(res.body.items[0].watchOrderItems[0].customTitle).toBe('One');
      expect(res.body.items[0].watchOrderItems[0].note).toBe('start here');
    });
  });
});
