import request from 'supertest';
import { AuthTestContext, pickCookie, startAuthApp } from './support/auth-app';

describe('Board view settings (integration)', () => {
  let ctx: AuthTestContext;
  let otherCreatorId: string;
  let reader: Auth;

  beforeAll(async () => {
    ctx = await startAuthApp();
    const owner = await ctx.prisma.user.create({ data: { patreonUserId: 'bs-owner' } });
    const board = async (slug: string, campaign: string) =>
      (
        await ctx.prisma.creator.create({
          data: {
            patreonCampaignId: campaign,
            ownerUserId: owner.id,
            displayName: slug,
            slug,
            policy: { create: { viewVisibility: 'PUBLIC' } },
            staff: { create: { userId: owner.id, role: 'OWNER' } },
          },
        })
      ).id;
    await board('bs-one', 'bs-campaign-1');
    otherCreatorId = await board('bs-two', 'bs-campaign-2');
    reader = await loginAs('bs-reader');
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.prisma.boardViewPreference.deleteMany();
    await setPremium(null);
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

  const setPremium = (until: Date | null) =>
    ctx.prisma.user.update({
      where: { patreonUserId: 'bs-reader' },
      data: { premiumUntil: until },
    });
  const premium = () => setPremium(new Date(Date.now() + 86_400_000));

  const get = (slug = 'bs-one') =>
    request(ctx.app.getHttpServer())
      .get(`/api/v1/creators/${slug}/view-settings`)
      .set('Cookie', [reader.session, reader.csrf]);

  const put = (body: object, slug = 'bs-one') =>
    request(ctx.app.getHttpServer())
      .put(`/api/v1/creators/${slug}/view-settings`)
      .set('Cookie', [reader.session, reader.csrf])
      .set('x-csrf-token', reader.csrfToken)
      .send(body);

  it('reads as empty when nothing has been arranged yet', async () => {
    // Not having arranged a board is the normal state. A 404 for it would be handled badly by
    // every client that has to special-case it.
    const res = await get().expect(200);

    expect(res.body).toEqual({ collapsed: [], sorts: {}, canSync: false });
  });

  it('stores and returns what a premium reader arranged', async () => {
    await premium();

    await put({ collapsed: ['PENDING'], sorts: { ACTIVE: 'manual' } }).expect(200);

    const res = await get().expect(200);
    expect(res.body).toEqual({
      collapsed: ['PENDING'],
      sorts: { ACTIVE: 'manual' },
      canSync: true,
    });
  });

  it('lets a free reader read, and refuses only the write', async () => {
    // Amendment A.1: arranging the board is not withheld — only its following you between
    // devices. So the page never has to know whether this reader pays in order to render.
    await get().expect(200);

    await put({ collapsed: ['PENDING'], sorts: {} }).expect(402);
    expect(await ctx.prisma.boardViewPreference.count()).toBe(0);
  });

  it('keeps one board’s arrangement out of another’s', async () => {
    await premium();

    await put({ collapsed: ['PENDING'], sorts: {} }, 'bs-one').expect(200);

    expect((await get('bs-two').expect(200)).body.collapsed).toEqual([]);
    expect(
      await ctx.prisma.boardViewPreference.count({ where: { creatorId: otherCreatorId } }),
    ).toBe(0);
  });

  it('rejects a sort value nothing downstream would catch', async () => {
    // `sorts` lands in a Json column, so the first thing to notice a bad value would be a column
    // asking the API to sort by nonsense.
    await premium();

    await put({ collapsed: [], sorts: { ACTIVE: 'by-vibes' } }).expect(400);
  });

  it('rejects a column that is not on the board', async () => {
    await premium();

    await put({ collapsed: [], sorts: { REJECTED: 'manual' } }).expect(400);
    await put({ collapsed: ['REJECTED'], sorts: {} }).expect(400);
  });

  it('404s a board that does not exist', async () => {
    await premium();
    await put({ collapsed: [], sorts: {} }, 'no-such-board').expect(404);
  });
});
