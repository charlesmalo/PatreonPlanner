import request from 'supertest';
import { AuthTestContext, pickCookie, startAuthApp } from './support/auth-app';

describe('Staff permissions (integration)', () => {
  let ctx: AuthTestContext;
  let creatorId: string;
  let owner: Auth;
  let mod: Auth;
  let modUserId: string;
  let patron: Auth;
  let entryId: string;
  let themeId: string;
  let flagId: string;

  beforeAll(async () => {
    ctx = await startAuthApp();
    owner = await loginAs('sp-owner');
    creatorId = (
      await ctx.prisma.creator.create({
        data: {
          patreonCampaignId: 'sp-campaign',
          ownerUserId: await userId('sp-owner'),
          displayName: 'Permission Co',
          slug: 'permission-co',
          policy: { create: {} },
          staff: { create: { userId: await userId('sp-owner'), role: 'OWNER' } },
        },
      })
    ).id;
    mod = await loginAs('sp-mod');
    modUserId = await userId('sp-mod');
    patron = await loginAs('sp-patron');
    await ctx.prisma.membership.create({
      data: {
        userId: await userId('sp-patron'),
        creatorId,
        amountCents: 500,
        isActivePatron: true,
      },
    });
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.prisma.flag.deleteMany();
    await ctx.prisma.creatorNote.deleteMany();
    await ctx.prisma.recommendation.deleteMany();
    await ctx.prisma.theme.deleteMany();
    await ctx.prisma.creatorStaff.deleteMany({ where: { creatorId, userId: modUserId } });
    entryId = (
      await ctx.prisma.recommendation.create({
        data: {
          creatorId,
          submittedByUserId: await userId('sp-patron'),
          type: 'EXTERNAL_LINK',
          customTitle: 'Akira',
          normalizedTitle: 'akira',
          status: 'PENDING',
        },
      })
    ).id;
    themeId = (await ctx.prisma.theme.create({ data: { creatorId, name: 'Anime', slug: 'anime' } }))
      .id;
    flagId = (
      await ctx.prisma.flag.create({
        data: {
          recommendationId: entryId,
          flaggedByUserId: await userId('sp-patron'),
          reason: 'SPAM',
        },
      })
    ).id;
  });

  const asMod = (permissions: string[]) =>
    ctx.prisma.creatorStaff.create({
      data: { creatorId, userId: modUserId, role: 'MOD', permissions: permissions as never },
    });

  const userId = async (patreonUserId: string) =>
    (await ctx.prisma.user.findUniqueOrThrow({ where: { patreonUserId } })).id;

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

  const send = (auth: Auth, method: 'post' | 'patch' | 'delete', path: string, body?: object) => {
    const req = request(ctx.app.getHttpServer())
      [method](`/api/v1/creators/permission-co${path}`)
      .set('Cookie', [auth.session, auth.csrf])
      .set('x-csrf-token', auth.csrfToken);
    return body ? req.send(body) : req;
  };

  /** Each moderated action, and the permission that should be required for it. */
  const actions = [
    {
      name: 'moving an entry',
      permission: 'MOVE_ENTRIES',
      run: (auth: Auth) =>
        send(auth, 'post', `/recommendations/${entryId}/status`, { status: 'ACCEPTED' }),
      ok: 200,
    },
    {
      name: 'picking an entry',
      permission: 'MOVE_ENTRIES',
      run: (auth: Auth) => send(auth, 'post', `/recommendations/${entryId}/pick`),
      ok: 204,
    },
    {
      name: 'redacting an entry',
      permission: 'EDIT_ENTRIES',
      run: (auth: Auth) =>
        send(auth, 'patch', `/recommendations/${entryId}`, { customTitle: 'Redacted' }),
      ok: 200,
    },
    {
      name: 'resolving a report',
      permission: 'HANDLE_REPORTS',
      run: (auth: Auth) => send(auth, 'patch', `/flags/${flagId}`, { status: 'DISMISSED' }),
      ok: 200,
    },
    {
      name: 'writing a note',
      permission: 'WRITE_NOTES',
      run: (auth: Auth) =>
        send(auth, 'post', `/recommendations/${entryId}/notes`, { body: 'A note', kind: 'NOTE' }),
      ok: 201,
    },
    {
      name: 'renaming a theme',
      permission: 'MANAGE_THEMES',
      run: (auth: Auth) => send(auth, 'patch', `/themes/${themeId}`, { name: 'Cartoons' }),
      ok: 200,
    },
  ] as const;

  describe('granting and revoking', () => {
    const setPermissions = (auth: Auth, targetId: string, permissions: string[]) =>
      request(ctx.app.getHttpServer())
        .patch(`/api/v1/creators/permission-co/staff/${targetId}/permissions`)
        .set('Cookie', [auth.session, auth.csrf])
        .set('x-csrf-token', auth.csrfToken)
        .send({ permissions });

    it('lets an owner grant', async () => {
      await asMod([]);

      await setPermissions(owner, modUserId, ['MOVE_ENTRIES']).expect(200);

      await send(mod, 'post', `/recommendations/${entryId}/pick`).expect(204);
    });

    it('lets an owner revoke', async () => {
      await asMod(['MOVE_ENTRIES']);

      await setPermissions(owner, modUserId, []).expect(200);

      await send(mod, 'post', `/recommendations/${entryId}/pick`).expect(403);
    });

    it('never lets a moderator grant themselves anything', async () => {
      // The obvious way to make the whole feature pointless.
      await asMod(['MOVE_ENTRIES']);

      await setPermissions(mod, modUserId, ['HANDLE_REPORTS', 'MANAGE_THEMES']).expect(403);

      await send(mod, 'patch', `/flags/${flagId}`, { status: 'DISMISSED' }).expect(403);
    });

    it('refuses to edit an owner, who holds everything by role', async () => {
      await setPermissions(owner, await userId('sp-owner'), []).expect(409);
    });

    it('rejects a permission that does not exist', async () => {
      await asMod([]);

      await setPermissions(owner, modUserId, ['DELETE_THE_BOARD']).expect(400);
    });

    it('404s someone who is not staff here', async () => {
      await setPermissions(owner, await userId('sp-patron'), ['MOVE_ENTRIES']).expect(404);
    });

    it('shows each moderator their permissions on the staff list', async () => {
      await asMod(['WRITE_NOTES']);

      const res = await request(ctx.app.getHttpServer())
        .get('/api/v1/creators/permission-co/staff')
        .set('Cookie', [owner.session, owner.csrf])
        .expect(200);

      const row = res.body.members.find((m: { userId: string }) => m.userId === modUserId);
      expect(row.permissions).toEqual(['WRITE_NOTES']);
    });
  });

  for (const action of actions) {
    describe(action.name, () => {
      it(`is allowed with ${action.permission}`, async () => {
        await asMod([action.permission]);

        await action.run(mod).expect(action.ok);
      });

      it('is refused with no permissions at all', async () => {
        await asMod([]);

        await action.run(mod).expect(403);
      });

      it('is refused while holding a different permission', async () => {
        // The test that matters: a check that merely asks "do they hold anything" would pass
        // every one of these, and the whole feature would be theatre.
        const other = action.permission === 'MOVE_ENTRIES' ? 'MANAGE_THEMES' : 'MOVE_ENTRIES';
        await asMod([other]);

        await action.run(mod).expect(403);
      });

      it('is always allowed for the owner', async () => {
        // Not by holding the set — an owner whose permissions could be edited is an owner who
        // can be locked out of their own board.
        await action.run(owner).expect(action.ok);
      });

      it('is refused for a patron, permissions or not', async () => {
        await action.run(patron).expect(403);
      });
    });
  }
});
