import request from 'supertest';
import { DEFAULT_MOVE_STATUSES } from '../src/notifications/board-followers.service';
import { AuthTestContext, pickCookie, startAuthApp } from './support/auth-app';

describe('Notification preferences (integration)', () => {
  let ctx: AuthTestContext;
  let creatorId: string;
  let otherCreatorId: string;
  let reader: Auth;
  let premiumReader: Auth;

  beforeAll(async () => {
    ctx = await startAuthApp();
    const owner = await ctx.prisma.user.create({ data: { patreonUserId: 'np-owner' } });
    const board = async (slug: string, campaign: string) =>
      (
        await ctx.prisma.creator.create({
          data: {
            patreonCampaignId: campaign,
            ownerUserId: owner.id,
            displayName: slug,
            slug,
            policy: { create: {} },
            staff: { create: { userId: owner.id, role: 'OWNER' } },
          },
        })
      ).id;
    creatorId = await board('prefs-co', 'np-campaign');
    otherCreatorId = await board('prefs-other', 'np-other');

    reader = await loginAs('np-reader');
    premiumReader = await loginAs('np-premium');
    await ctx.prisma.user.update({
      where: { patreonUserId: 'np-premium' },
      // A year out. Nothing sets this in production yet — the gate is built closed.
      data: { premiumUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) },
    });
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.prisma.boardNotificationPreference.deleteMany();
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

  const get = (auth: Auth, slug = 'prefs-co') =>
    request(ctx.app.getHttpServer())
      .get(`/api/v1/creators/${slug}/notification-preferences`)
      .set('Cookie', [auth.session, auth.csrf]);

  const put = (auth: Auth, body: object, slug = 'prefs-co') =>
    request(ctx.app.getHttpServer())
      .put(`/api/v1/creators/${slug}/notification-preferences`)
      .set('Cookie', [auth.session, auth.csrf])
      .set('x-csrf-token', auth.csrfToken)
      .send(body);

  describe('reading', () => {
    it('reports the default, and says it is the default', async () => {
      // A client that cannot tell "the default" from "a choice that happens to match it" renders
      // an empty form and invites someone to re-pick what they already have.
      const res = await get(reader).expect(200);

      expect(res.body.statuses).toEqual(DEFAULT_MOVE_STATUSES);
      expect(res.body.isDefault).toBe(true);
    });

    it('tells a free reader they may not customise, rather than hiding it', async () => {
      const res = await get(reader).expect(200);
      expect(res.body.canCustomise).toBe(false);

      const premium = await get(premiumReader).expect(200);
      expect(premium.body.canCustomise).toBe(true);
    });
  });

  describe('writing', () => {
    it('stores a premium reader’s set and reports it as chosen', async () => {
      await put(premiumReader, { statuses: ['ACCEPTED', 'ACTIVE'] }).expect(200);

      const res = await get(premiumReader).expect(200);
      expect(res.body.statuses).toEqual(['ACCEPTED', 'ACTIVE']);
      expect(res.body.isDefault).toBe(false);
    });

    it('stores an empty set as silence, not as the default', async () => {
      await put(premiumReader, { statuses: [] }).expect(200);

      const res = await get(premiumReader).expect(200);
      expect(res.body.statuses).toEqual([]);
      expect(res.body.isDefault).toBe(false);
    });

    it('replaces the set outright rather than merging into it', async () => {
      // The page edits a set of checkboxes; a partial update races two open tabs into a merge
      // nobody asked for. The staff permissions endpoint carries the same reasoning.
      await put(premiumReader, { statuses: ['ACCEPTED', 'ACTIVE'] }).expect(200);
      await put(premiumReader, { statuses: ['COMPLETED'] }).expect(200);

      expect((await get(premiumReader).expect(200)).body.statuses).toEqual(['COMPLETED']);
    });

    it('refuses a free reader with 402 rather than silently ignoring them', async () => {
      // Amendment A.1: being notified is free forever; only the granularity is bought. A silent
      // no-op would leave them believing they had configured something.
      await put(reader, { statuses: ['COMPLETED'] }).expect(402);

      expect(await ctx.prisma.boardNotificationPreference.count()).toBe(0);
    });

    it('keeps one board’s preference out of another’s', async () => {
      await put(premiumReader, { statuses: ['COMPLETED'] }, 'prefs-co').expect(200);

      const other = await get(premiumReader, 'prefs-other').expect(200);
      expect(other.body.isDefault).toBe(true);
      expect(
        await ctx.prisma.boardNotificationPreference.count({
          where: { creatorId: otherCreatorId },
        }),
      ).toBe(0);
    });

    it('rejects a status that is not a real column', async () => {
      await put(premiumReader, { statuses: ['NONSENSE'] }).expect(400);
    });

    it('rejects DELETED and REJECTED, which are not columns a reader sees', async () => {
      // They are off the board by design. Offering them would promise notifications about
      // entries the reader can never look at.
      await put(premiumReader, { statuses: ['REJECTED'] }).expect(400);
    });

    it('404s a board that does not exist', async () => {
      await put(premiumReader, { statuses: [] }, 'no-such-board').expect(404);
    });
  });
});
