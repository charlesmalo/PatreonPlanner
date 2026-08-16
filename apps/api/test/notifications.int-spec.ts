import request from 'supertest';
import { NotificationsService } from '../src/notifications/notifications.service';
import { AuthTestContext, pickCookie, startAuthApp } from './support/auth-app';

describe('Notifications (integration)', () => {
  let ctx: AuthTestContext;
  let service: NotificationsService;
  let creatorId: string;
  let otherCreatorId: string;
  let alice: string;
  let bob: string;

  beforeAll(async () => {
    ctx = await startAuthApp();
    service = ctx.app.get(NotificationsService);
    const owner = await ctx.prisma.user.create({ data: { patreonUserId: 'nf-owner' } });
    creatorId = (
      await ctx.prisma.creator.create({
        data: {
          patreonCampaignId: 'nf-campaign',
          ownerUserId: owner.id,
          displayName: 'Notify Co',
          slug: 'notify-co',
          policy: { create: {} },
        },
      })
    ).id;
    otherCreatorId = (
      await ctx.prisma.creator.create({
        data: {
          patreonCampaignId: 'nf-other',
          ownerUserId: owner.id,
          displayName: 'Other',
          slug: 'nf-other',
          policy: { create: {} },
        },
      })
    ).id;
    alice = (await ctx.prisma.user.create({ data: { patreonUserId: 'nf-alice' } })).id;
    bob = (await ctx.prisma.user.create({ data: { patreonUserId: 'nf-bob' } })).id;
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.prisma.notification.deleteMany();
  });

  const row = (userId: string, title = 'Cowboy Bebop') => ({
    userId,
    creatorId,
    type: 'ENTRY_STATUS_CHANGED' as const,
    payload: {
      recommendationId: '00000000-0000-4000-8000-000000000001',
      title,
      creatorSlug: 'notify-co',
      creatorName: 'Notify Co',
      status: 'ACCEPTED' as const,
    },
  });

  it('stores a notification for the recipient only', async () => {
    await service.emit(ctx.prisma, [row(alice)]);

    expect(await service.unreadCount(alice)).toBe(1);
    expect(await service.unreadCount(bob)).toBe(0);
  });

  it('never returns another user notifications', async () => {
    await service.emit(ctx.prisma, [row(alice)]);

    expect((await service.list(bob)).items).toEqual([]);
  });

  it('marks only the requested rows read, and only the caller own', async () => {
    await service.emit(ctx.prisma, [row(alice), row(bob)]);
    const { items } = await service.list(alice);

    // Someone else's id in the body is not a way to reach someone else's row.
    expect(await service.markRead(bob, [items[0].id])).toBe(0);
    expect(await service.unreadCount(alice)).toBe(1);

    expect(await service.markRead(alice, [items[0].id])).toBe(1);
    expect(await service.unreadCount(alice)).toBe(0);
  });

  it('marks every unread row when no ids are given', async () => {
    await service.emit(ctx.prisma, [row(alice, 'One'), row(alice, 'Two'), row(bob)]);

    expect(await service.markRead(alice)).toBe(2);
    expect(await service.unreadCount(alice)).toBe(0);
    expect(await service.unreadCount(bob)).toBe(1);
  });

  it('pages newest first without repeating a row', async () => {
    // Keyset rather than offset: the list grows at the head, so an offset page two would show a
    // row that page one already carried.
    //
    // The timestamps are set explicitly: createdAt is TIMESTAMP(3), and three emits in the same
    // millisecond would leave the order to the id tiebreak and flake.
    await seedInOrder(['One', 'Two', 'Three']);

    const first = await service.list(alice, undefined, 2);
    expect(first.items.map((n) => (n.payload as { title: string }).title)).toEqual([
      'Three',
      'Two',
    ]);
    const second = await service.list(alice, first.nextCursor as string, 2);
    expect(second.items.map((n) => (n.payload as { title: string }).title)).toEqual(['One']);
    expect(second.nextCursor).toBeNull();
  });

  const seedInOrder = async (titles: string[]) => {
    for (const [index, title] of titles.entries()) {
      await service.emit(ctx.prisma, [row(alice, title)]);
      await ctx.prisma.notification.updateMany({
        where: { payload: { path: ['title'], equals: title } },
        data: { createdAt: new Date(Date.UTC(2026, 7, 24, 0, 0, index)) },
      });
    }
  };

  it('goes when the board goes', async () => {
    // A notification about a board nobody can reach any more is not worth keeping, and the
    // payload it carries is a snapshot of that board's content.
    await service.emit(ctx.prisma, [{ ...row(alice), creatorId: otherCreatorId }]);
    await ctx.prisma.creator.delete({ where: { id: otherCreatorId } });

    expect(await service.unreadCount(alice)).toBe(0);
  });

  describe('the endpoints', () => {
    let aliceAuth: Awaited<ReturnType<typeof loginAs>>;
    let bobAuth: Awaited<ReturnType<typeof loginAs>>;

    beforeAll(async () => {
      aliceAuth = await loginAs('nf-alice');
      bobAuth = await loginAs('nf-bob');
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

    const get = (auth: Auth, path: string) =>
      request(ctx.app.getHttpServer())
        .get(`/api/v1/notifications${path}`)
        .set('Cookie', [auth.session, auth.csrf]);

    const markRead = (auth: Auth, body: object) =>
      request(ctx.app.getHttpServer())
        .post('/api/v1/notifications/read')
        .set('Cookie', [auth.session, auth.csrf])
        .set('x-csrf-token', auth.csrfToken)
        .send(body);

    it('requires a session', async () => {
      await request(ctx.app.getHttpServer()).get('/api/v1/notifications').expect(401);
      await request(ctx.app.getHttpServer()).get('/api/v1/notifications/unread-count').expect(401);
    });

    it('returns only the caller notifications', async () => {
      await service.emit(ctx.prisma, [row(alice, 'Hers'), row(bob, 'His')]);

      const res = await get(aliceAuth, '').expect(200);
      expect(res.body.items.map((n: { payload: { title: string } }) => n.payload.title)).toEqual([
        'Hers',
      ]);
      expect((await get(aliceAuth, '/unread-count').expect(200)).body).toEqual({ count: 1 });
    });

    it('refuses to mark another user notification read', async () => {
      await service.emit(ctx.prisma, [row(alice)]);
      const mine = (await service.list(alice)).items[0];

      await markRead(bobAuth, { ids: [mine.id] }).expect(200);

      expect(await service.unreadCount(alice)).toBe(1);
    });

    it('pages through the endpoint, not just the service', async () => {
      // The controller has to pass the cursor through; without it every page is page one.
      await seedInOrder(['One', 'Two', 'Three']);
      const all = (await service.list(alice)).items;

      const res = await get(aliceAuth, `?cursor=${all[0].id}`).expect(200);

      expect(res.body.items.map((n: { id: string }) => n.id)).toEqual([all[1].id, all[2].id]);
    });

    it('rejects a write without the CSRF token', async () => {
      await service.emit(ctx.prisma, [row(alice)]);

      await request(ctx.app.getHttpServer())
        .post('/api/v1/notifications/read')
        .set('Cookie', [aliceAuth.session, aliceAuth.csrf])
        .send({})
        .expect(403);

      expect(await service.unreadCount(alice)).toBe(1);
    });

    it('marks the caller own read', async () => {
      await service.emit(ctx.prisma, [row(alice)]);

      const res = await markRead(aliceAuth, {}).expect(200);

      expect(res.body).toEqual({ updated: 1 });
      expect(await service.unreadCount(alice)).toBe(0);
    });
  });
});
