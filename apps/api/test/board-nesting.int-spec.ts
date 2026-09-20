import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AuthTestContext, pickCookie, startAuthApp } from './support/auth-app';
import { ALL_STAFF_PERMISSIONS } from '../src/access/permissions';

describe('Board nesting and theme filtering (integration)', () => {
  let ctx: AuthTestContext;
  let creatorId: string;
  let otherCreatorId: string;
  let patron: Auth;
  let otherPatron: Auth;
  let staff: Auth;
  let patronUserId: string;

  let showTitleId: string;
  let seasonTitleId: string;
  let collectionTitleId: string;
  let filmTitleId: string;
  let similarTitleId: string;

  let showId: string;
  let seasonId: string;
  let collectionId: string;
  let filmId: string;
  let similarId: string;
  let themeId: string;
  let otherThemeId: string;

  beforeAll(async () => {
    ctx = await startAuthApp();
    const owner = await ctx.prisma.user.create({ data: { patreonUserId: 'nest-owner' } });
    const creator = await ctx.prisma.creator.create({
      data: {
        patreonCampaignId: 'nest-campaign',
        ownerUserId: owner.id,
        displayName: 'Nesting Co',
        slug: 'nesting-co',
        policy: { create: { viewVisibility: 'PUBLIC' } },
      },
    });
    creatorId = creator.id;
    otherCreatorId = (
      await ctx.prisma.creator.create({
        data: {
          patreonCampaignId: 'nest-other',
          ownerUserId: owner.id,
          displayName: 'Other',
          slug: 'nest-other',
          policy: { create: { viewVisibility: 'PUBLIC' } },
        },
      })
    ).id;

    patron = await loginAs('nest-patron');
    patronUserId = (
      await ctx.prisma.user.findUniqueOrThrow({ where: { patreonUserId: 'nest-patron' } })
    ).id;
    await ctx.prisma.membership.create({
      data: { userId: patronUserId, creatorId, amountCents: 500, isActivePatron: true },
    });
    otherPatron = await loginAs('nest-other-patron');
    await ctx.prisma.membership.create({
      data: {
        userId: (
          await ctx.prisma.user.findUniqueOrThrow({
            where: { patreonUserId: 'nest-other-patron' },
          })
        ).id,
        creatorId,
        amountCents: 500,
        isActivePatron: true,
      },
    });
    staff = await loginAs('nest-staff');
    await ctx.prisma.creatorStaff.create({
      data: {
        creatorId,
        userId: (
          await ctx.prisma.user.findUniqueOrThrow({ where: { patreonUserId: 'nest-staff' } })
        ).id,
        role: 'MOD',
        permissions: ALL_STAFF_PERMISSIONS,
      },
    });
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    // Every test here reads the board, and a board read queues background availability refreshes
    // that outlive it. Draining first is the same isolation fix the availability suite needed
    // once review pointed out that a queued refresh can write *after* the next test's deletes.
    await ctx.availabilityService.drainRefreshes();
    await ctx.prisma.recommendation.deleteMany();
    await ctx.prisma.titleRelation.deleteMany();
    await ctx.prisma.titleTheme.deleteMany();
    await ctx.prisma.theme.deleteMany();
    await ctx.prisma.title.deleteMany();
    await ctx.prisma.creatorPolicy.updateMany({ data: { hidePendingFromPublic: false } });

    showTitleId = (await makeTitle(1, 'TV', 'A Show')).id;
    seasonTitleId = (await makeTitle(2, 'TV', 'A Show: Season 2')).id;
    collectionTitleId = (await makeTitle(10, 'COLLECTION', 'A Franchise')).id;
    filmTitleId = (await makeTitle(3, 'MOVIE', 'A Film')).id;
    similarTitleId = (await makeTitle(4, 'MOVIE', 'Something Similar')).id;

    // Member → container, always. Nesting reads the direction, so a reversed row would put a
    // show under its own season.
    await relate(seasonTitleId, showTitleId, 'SEASON_OF');
    await relate(filmTitleId, collectionTitleId, 'SAME_FRANCHISE');
    await relate(filmTitleId, similarTitleId, 'RELATED');

    showId = (await makeEntry(showTitleId, 'SHOW')).id;
    seasonId = (await makeEntry(seasonTitleId, 'SHOW')).id;
    collectionId = (await makeEntry(collectionTitleId, 'FRANCHISE')).id;
    filmId = (await makeEntry(filmTitleId, 'MOVIE')).id;
    similarId = (await makeEntry(similarTitleId, 'MOVIE')).id;

    const theme = await ctx.prisma.theme.create({
      data: { creatorId, name: 'Anime', slug: 'anime' },
    });
    themeId = theme.id;
    await ctx.prisma.titleTheme.create({ data: { titleId: filmTitleId, themeId } });

    // A second label on a *different* entry, so a two-label filter has something to prove: with
    // OR both entries come back, with AND neither would.
    const second = await ctx.prisma.theme.create({
      data: { creatorId, name: 'Documentary', slug: 'documentary' },
    });
    otherThemeId = second.id;
    await ctx.prisma.titleTheme.create({
      data: { titleId: showTitleId, themeId: otherThemeId },
    });
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

  const makeTitle = (tmdbId: number, mediaType: 'MOVIE' | 'TV' | 'COLLECTION', name: string) =>
    ctx.prisma.title.create({ data: { tmdbId, mediaType, name } });

  const relate = (fromId: string, toId: string, kind: 'SEASON_OF' | 'SAME_FRANCHISE' | 'RELATED') =>
    ctx.prisma.titleRelation.create({ data: { fromId, toId, kind } });

  let counter = 0;
  async function makeEntry(titleId: string, type: 'MOVIE' | 'SHOW' | 'FRANCHISE') {
    counter += 1;
    return ctx.prisma.recommendation.create({
      data: {
        creatorId,
        submittedByUserId: patronUserId,
        type,
        titleId,
        customTitle: `Entry ${counter}`,
        normalizedTitle: `entry ${counter}`,
      },
    });
  }

  const board = (auth: Auth, query = '') =>
    request(ctx.app.getHttpServer())
      .get(`/api/v1/creators/nesting-co/recommendations?limit=50${query}`)
      .set('Cookie', [auth.session, auth.csrf]);

  const entry = (body: { items: Array<{ id: string }> }, id: string) =>
    body.items.find((i) => i.id === id) as unknown as {
      parentId: string | null;
      parentSource: 'STAFF' | 'CATALOGUE' | null;
      themes: Array<{ id: string; name: string }>;
    };

  it('nests a season under its show when both are on the board', async () => {
    const res = await board(patron).expect(200);
    expect(entry(res.body, seasonId).parentId).toBe(showId);
  });

  it('nests a film under its franchise', async () => {
    const res = await board(patron).expect(200);
    expect(entry(res.body, filmId).parentId).toBe(collectionId);
  });

  it('says a nesting the catalogue implied came from the catalogue, not from staff', async () => {
    // The other half of the distinction `parentSource` exists for. Nobody chose this one, so
    // there is no group to undo — and a control that offered to undo it would do nothing.
    const res = await board(patron).expect(200);
    expect(entry(res.body, seasonId).parentSource).toBe('CATALOGUE');
    expect(entry(res.body, showId).parentSource).toBeNull();
  });

  it('picks the container, never the member, as the parent', async () => {
    // The relation is directional; nesting the show under its own season is what this guards.
    const res = await board(patron).expect(200);
    expect(entry(res.body, showId).parentId).toBeNull();
    expect(entry(res.body, collectionId).parentId).toBeNull();
  });

  it('leaves a season unnested when the show is not on the board', async () => {
    await ctx.prisma.recommendation.delete({ where: { id: showId } });
    const res = await board(patron).expect(200);
    expect(entry(res.body, seasonId).parentId).toBeNull();
  });

  it('does not nest under an entry the viewer cannot see', async () => {
    // Nesting must not leak the existence of a hidden entry.
    await ctx.prisma.recommendation.update({
      where: { id: showId },
      data: { status: 'REJECTED' },
    });
    const res = await board(patron).expect(200);
    expect(entry(res.body, seasonId).parentId).toBeNull();
  });

  it('does not nest on a RELATED pair', async () => {
    // "Similar" is not "contained by"; nesting on it would bury unrelated entries.
    const res = await board(patron).expect(200);
    expect(entry(res.body, similarId).parentId).toBeNull();
    expect(entry(res.body, filmId).parentId).toBe(collectionId);
  });

  it('returns each entry themes', async () => {
    const res = await board(patron).expect(200);
    expect(entry(res.body, filmId).themes).toEqual([{ id: themeId, name: 'Anime' }]);
    expect(entry(res.body, showId).themes).toEqual([{ id: otherThemeId, name: 'Documentary' }]);
    expect(entry(res.body, similarId).themes).toEqual([]);
  });

  it('narrows the board to one label', async () => {
    const res = await board(patron, `&themes=${themeId}`).expect(200);
    expect(res.body.items.map((i: { id: string }) => i.id)).toEqual([filmId]);
  });

  it('matches either label rather than both', async () => {
    // OR, not AND: the two labels sit on different entries, so an AND would return nothing and
    // this assertion would be the one that caught it.
    const res = await board(patron, `&themes=${themeId},${otherThemeId}`).expect(200);
    const ids = res.body.items.map((i: { id: string }) => i.id);
    expect(ids).toContain(filmId);
    expect(ids).toContain(showId);
  });

  it('does not return an entry twice when it carries two of the selected labels', async () => {
    // `some` with `in` matches the row once however many labels hit, but a join written the
    // obvious way would duplicate it — and a duplicated entry breaks keyset pagination.
    await ctx.prisma.titleTheme.create({ data: { titleId: filmTitleId, themeId: otherThemeId } });
    const res = await board(patron, `&themes=${themeId},${otherThemeId}`).expect(200);
    const ids = res.body.items.map((i: { id: string }) => i.id);
    expect(ids.filter((id: string) => id === filmId)).toHaveLength(1);
  });

  it('rejects a label belonging to another creator, even alongside a valid one', async () => {
    const foreign = await ctx.prisma.theme.create({
      data: { creatorId: otherCreatorId, name: 'Anime', slug: 'anime' },
    });
    await board(patron, `&themes=${foreign.id}`).expect(404);
    // The whole filter is refused rather than the foreign id quietly dropped, which would answer
    // a question the caller did not ask.
    await board(patron, `&themes=${themeId},${foreign.id}`).expect(404);
  });

  it('rejects an unknown label', async () => {
    await board(patron, `&themes=${randomUUID()}`).expect(404);
  });

  it('rejects a label list that is not uuids', async () => {
    await board(patron, `&themes=not-a-uuid`).expect(400);
  });

  it('applies the same visibility rules with a label filter', async () => {
    // The filter narrows the existing read model; it must not become a second place the
    // visibility rules live.
    await ctx.prisma.creatorPolicy.update({
      where: { creatorId },
      data: { hidePendingFromPublic: true },
    });
    const res = await board(otherPatron, `&themes=${themeId}`).expect(200);
    expect(res.body.items).toHaveLength(0);

    const asStaff = await board(staff, `&themes=${themeId}`).expect(200);
    expect(asStaff.body.items.map((i: { id: string }) => i.id)).toEqual([filmId]);
  });

  it('leaves an external-link entry unnested and unthemed', async () => {
    const link = await ctx.prisma.recommendation.create({
      data: {
        creatorId,
        submittedByUserId: patronUserId,
        type: 'EXTERNAL_LINK',
        customTitle: 'A link',
        normalizedTitle: 'a link',
      },
    });
    const res = await board(patron).expect(200);
    expect(entry(res.body, link.id).parentId).toBeNull();
    expect(entry(res.body, link.id).themes).toEqual([]);
  });
});
