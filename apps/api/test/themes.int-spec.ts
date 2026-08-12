import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AuthTestContext, pickCookie, startAuthApp } from './support/auth-app';

describe('Theme curation (integration)', () => {
  let ctx: AuthTestContext;
  let creatorId: string;
  let otherCreatorId: string;
  let patron: Auth;
  let staff: Auth;
  let themeId: string;
  let titleId: string;

  beforeAll(async () => {
    ctx = await startAuthApp();
    const owner = await ctx.prisma.user.create({ data: { patreonUserId: 'th-owner' } });
    const creator = await ctx.prisma.creator.create({
      data: {
        patreonCampaignId: 'th-campaign',
        ownerUserId: owner.id,
        displayName: 'Theme Co',
        slug: 'theme-co',
        policy: { create: {} },
      },
    });
    creatorId = creator.id;
    otherCreatorId = (
      await ctx.prisma.creator.create({
        data: {
          patreonCampaignId: 'th-other',
          ownerUserId: owner.id,
          displayName: 'Other',
          slug: 'th-other',
          policy: { create: {} },
        },
      })
    ).id;

    patron = await loginAs('th-patron');
    await ctx.prisma.membership.create({
      data: {
        userId: (await ctx.prisma.user.findUniqueOrThrow({ where: { patreonUserId: 'th-patron' } }))
          .id,
        creatorId,
        amountCents: 500,
        isActivePatron: true,
      },
    });
    staff = await loginAs('th-staff');
    await ctx.prisma.creatorStaff.create({
      data: {
        creatorId,
        userId: (await ctx.prisma.user.findUniqueOrThrow({ where: { patreonUserId: 'th-staff' } }))
          .id,
        role: 'MOD',
      },
    });
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.prisma.titleTheme.deleteMany();
    await ctx.prisma.theme.deleteMany();
    await ctx.prisma.title.deleteMany();
    titleId = (
      await ctx.prisma.title.create({ data: { tmdbId: 1, mediaType: 'MOVIE', name: 'A Film' } })
    ).id;
    themeId = (
      await ctx.prisma.theme.create({
        data: { creatorId, name: 'Anime', slug: 'anime', sourceKey: 'anime' },
      })
    ).id;
    await ctx.prisma.titleTheme.create({ data: { titleId, themeId } });
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

  const list = (auth: Auth) =>
    request(ctx.app.getHttpServer())
      .get('/api/v1/creators/theme-co/themes')
      .set('Cookie', [auth.session, auth.csrf]);

  const patch = (auth: Auth, id: string, body: object) =>
    request(ctx.app.getHttpServer())
      .patch(`/api/v1/creators/theme-co/themes/${id}`)
      .set('Cookie', [auth.session, auth.csrf])
      .set('x-csrf-token', auth.csrfToken)
      .send(body);

  const remove = (auth: Auth, id: string) =>
    request(ctx.app.getHttpServer())
      .delete(`/api/v1/creators/theme-co/themes/${id}`)
      .set('Cookie', [auth.session, auth.csrf])
      .set('x-csrf-token', auth.csrfToken);

  it('lists the creator themes with how many titles carry each', async () => {
    const res = await list(patron).expect(200);
    expect(res.body.items).toEqual([{ id: themeId, name: 'Anime', titleCount: 1 }]);
  });

  it('never lists another creator themes', async () => {
    await ctx.prisma.theme.create({
      data: { creatorId: otherCreatorId, name: 'Foreign', slug: 'foreign', sourceKey: 'foreign' },
    });
    const res = await list(patron).expect(200);
    expect(res.body.items.map((t: { name: string }) => t.name)).toEqual(['Anime']);
  });

  it('renames a theme and keeps its assignments', async () => {
    await patch(staff, themeId, { name: 'Cartoons' }).expect(200);
    const row = await ctx.prisma.theme.findUniqueOrThrow({ where: { id: themeId } });
    expect(row).toMatchObject({ name: 'Cartoons', slug: 'cartoons' });
    // The source key is untouched, which is what stops re-seeding from resurrecting the old name.
    expect(row.sourceKey).toBe('anime');
    expect(await ctx.prisma.titleTheme.count({ where: { themeId } })).toBe(1);
  });

  it('refuses a rename from a patron', async () => {
    await patch(patron, themeId, { name: 'Mine' }).expect(403);
  });

  it('refuses a rename that collides with an existing theme', async () => {
    const other = await ctx.prisma.theme.create({
      data: { creatorId, name: 'Fantasy', slug: 'fantasy', sourceKey: 'fantasy' },
    });
    await patch(staff, other.id, { name: 'anime' }).expect(409);
  });

  it('allows a rename that only changes the casing of its own name', async () => {
    // The collision check must not treat a theme as colliding with itself.
    await patch(staff, themeId, { name: 'ANIME' }).expect(200);
  });

  it('runs a rename through moderation', async () => {
    // Theme names are shown on a public board, so they are user strings like any other.
    await patch(staff, themeId, { name: 'this is shit' }).expect(400);
  });

  it('refuses a theme belonging to another creator', async () => {
    const foreign = await ctx.prisma.theme.create({
      data: { creatorId: otherCreatorId, name: 'Foreign', slug: 'foreign', sourceKey: 'foreign' },
    });
    await patch(staff, foreign.id, { name: 'Mine' }).expect(404);
    await remove(staff, foreign.id).expect(404);
  });

  it('404s an unknown theme', async () => {
    await patch(staff, randomUUID(), { name: 'X' }).expect(404);
  });

  it('deletes a theme and its assignments without touching the title', async () => {
    await remove(staff, themeId).expect(204);
    expect(await ctx.prisma.theme.count({ where: { id: themeId } })).toBe(0);
    expect(await ctx.prisma.titleTheme.count()).toBe(0);
    expect(await ctx.prisma.title.count({ where: { id: titleId } })).toBe(1);
  });

  it('refuses a delete from a patron', async () => {
    await remove(patron, themeId).expect(403);
  });
});
