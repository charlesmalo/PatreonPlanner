import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import { MAX_PENDING_INVITES } from '../src/staff/staff.service';
import { AuthTestContext, pickCookie, startAuthApp } from './support/auth-app';
import { ALL_STAFF_PERMISSIONS } from '../src/access/permissions';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

describe('Staff management (integration)', () => {
  let ctx: AuthTestContext;
  let creatorId: string;
  let otherCreatorId: string;
  let owner: Auth;
  let mod: Auth;
  let stranger: Auth;
  let otherStranger: Auth;
  let ownerUserId: string;
  let modUserId: string;
  let strangerUserId: string;

  beforeAll(async () => {
    ctx = await startAuthApp();
    owner = await loginAs('st-owner');
    ownerUserId = (
      await ctx.prisma.user.findUniqueOrThrow({ where: { patreonUserId: 'st-owner' } })
    ).id;

    const creator = await ctx.prisma.creator.create({
      data: {
        patreonCampaignId: 'st-campaign',
        ownerUserId,
        displayName: 'Staff Co',
        slug: 'staff-co',
        policy: { create: { viewVisibility: 'PUBLIC' } },
        staff: { create: { userId: ownerUserId, role: 'OWNER' } },
      },
    });
    creatorId = creator.id;

    const other = await ctx.prisma.creator.create({
      data: {
        patreonCampaignId: 'st-other',
        ownerUserId,
        displayName: 'Other Co',
        slug: 'st-other',
        policy: { create: { viewVisibility: 'PUBLIC' } },
        staff: { create: { userId: ownerUserId, role: 'OWNER' } },
      },
    });
    otherCreatorId = other.id;

    mod = await loginAs('st-mod');
    modUserId = (await ctx.prisma.user.findUniqueOrThrow({ where: { patreonUserId: 'st-mod' } }))
      .id;
    stranger = await loginAs('st-stranger');
    strangerUserId = (
      await ctx.prisma.user.findUniqueOrThrow({ where: { patreonUserId: 'st-stranger' } })
    ).id;
    otherStranger = await loginAs('st-other-stranger');
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.prisma.staffInvite.deleteMany();
    await ctx.prisma.creatorStaff.deleteMany({ where: { userId: { not: ownerUserId } } });
    await ctx.prisma.creatorStaff.upsert({
      where: { creatorId_userId: { creatorId, userId: modUserId } },
      create: { creatorId, userId: modUserId, role: 'MOD', permissions: ALL_STAFF_PERMISSIONS },
      update: { role: 'MOD', permissions: ALL_STAFF_PERMISSIONS },
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
    return {
      session: pickCookie(res, 'pp_session'),
      csrf,
      csrfToken: csrf.split('=').slice(1).join('='),
    };
  }

  type Auth = Awaited<ReturnType<typeof loginAs>>;

  /** A CSRF pair with no session, so a request reaches the guards instead of the middleware. */
  async function anonymousCsrf() {
    const res = await request(ctx.app.getHttpServer()).get('/api/v1/creators/staff-co').expect(200);
    const csrf = pickCookie(res, 'pp_csrf').split(';')[0];
    return { csrf, csrfToken: csrf.split('=').slice(1).join('=') };
  }

  const post = (auth: Auth, path: string, body: object = {}) =>
    request(ctx.app.getHttpServer())
      .post(`/api/v1${path}`)
      .set('Cookie', [auth.session, auth.csrf])
      .set('x-csrf-token', auth.csrfToken)
      .send(body);

  const del = (auth: Auth, path: string) =>
    request(ctx.app.getHttpServer())
      .delete(`/api/v1${path}`)
      .set('Cookie', [auth.session, auth.csrf])
      .set('x-csrf-token', auth.csrfToken);

  const get = (auth: Auth, path: string) =>
    request(ctx.app.getHttpServer()).get(`/api/v1${path}`).set('Cookie', [auth.session, auth.csrf]);

  const invite = (auth: Auth = owner, slug = 'staff-co') =>
    post(auth, `/creators/${slug}/staff/invites`);

  const roleOf = async (userId: string, target = creatorId) =>
    (
      await ctx.prisma.creatorStaff.findUnique({
        where: { creatorId_userId: { creatorId: target, userId } },
      })
    )?.role ?? null;

  describe('creating invites', () => {
    it('returns the token once and stores only its hash', async () => {
      const res = await invite().expect(201);
      expect(res.body.token).toMatch(/^[A-Za-z0-9_-]{32,}$/);
      const row = await ctx.prisma.staffInvite.findFirstOrThrow();
      expect(row.tokenHash).not.toBe(res.body.token);
      expect(row.tokenHash).toBe(sha256(res.body.token));
    });

    it('never returns the token again', async () => {
      await invite().expect(201);
      const list = await get(owner, '/creators/staff-co/staff').expect(200);
      expect(JSON.stringify(list.body)).not.toMatch(/token/i);
    });

    it('refuses a moderator', async () => {
      await invite(mod).expect(403);
    });

    it('refuses a stranger and an anonymous caller', async () => {
      await invite(stranger).expect(403);
      // With a valid anonymous CSRF pair, so the request actually reaches the guards rather
      // than stopping at the middleware — otherwise this asserts nothing about authorization.
      const anon = await anonymousCsrf();
      await request(ctx.app.getHttpServer())
        .post('/api/v1/creators/staff-co/staff/invites')
        .set('Cookie', [anon.csrf])
        .set('x-csrf-token', anon.csrfToken)
        .expect(401);
    });

    it('caps how many invites can be outstanding', async () => {
      // An unbounded generator is an unbounded set of live credentials.
      for (let i = 0; i < MAX_PENDING_INVITES; i += 1) await invite().expect(201);
      await invite().expect(409);
    });

    it('does not count spent invites against the cap', async () => {
      for (let i = 0; i < MAX_PENDING_INVITES; i += 1) await invite().expect(201);
      const spent = await ctx.prisma.staffInvite.findFirstOrThrow();
      await ctx.prisma.staffInvite.update({
        where: { id: spent.id },
        data: { revokedAt: new Date() },
      });
      await invite().expect(201);
    });
  });

  describe('listing and revoking', () => {
    it('lists exactly this creator members and pending invites', async () => {
      // Asserted as an exact set with the other creator populated, because arrayContaining
      // tolerates extras — dropping the creatorId filter would leak every tenant's roster,
      // names and all, and the looser assertion passed anyway.
      await ctx.prisma.creatorStaff.create({
        data: {
          creatorId: otherCreatorId,
          userId: strangerUserId,
          role: 'MOD',
          permissions: ALL_STAFF_PERMISSIONS,
        },
      });
      await invite().expect(201);
      await invite(owner, 'st-other').expect(201);

      const res = await get(owner, '/creators/staff-co/staff').expect(200);
      expect(res.body.members.map((m: { userId: string }) => m.userId).sort()).toEqual(
        [ownerUserId, modUserId].sort(),
      );
      expect(res.body.invites).toHaveLength(1);
    });

    it('omits accepted, revoked and expired invites', async () => {
      const live = (await invite().expect(201)).body;
      const used = (await invite().expect(201)).body;
      const gone = (await invite().expect(201)).body;
      await ctx.prisma.staffInvite.update({
        where: { tokenHash: sha256(used.token) },
        data: { acceptedAt: new Date(), acceptedByUserId: strangerUserId },
      });
      await ctx.prisma.staffInvite.update({
        where: { tokenHash: sha256(gone.token) },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const res = await get(owner, '/creators/staff-co/staff').expect(200);
      expect(res.body.invites).toHaveLength(1);
      expect(res.body.invites[0].id).toBe(
        (
          await ctx.prisma.staffInvite.findUniqueOrThrow({
            where: { tokenHash: sha256(live.token) },
          })
        ).id,
      );
    });

    it('revokes an invite, and the revoked token no longer works', async () => {
      const { token } = (await invite().expect(201)).body;
      const row = await ctx.prisma.staffInvite.findUniqueOrThrow({
        where: { tokenHash: sha256(token) },
      });
      await del(owner, `/creators/staff-co/staff/invites/${row.id}`).expect(204);
      await post(stranger, '/staff/invites/accept', { token }).expect(404);
    });

    it('refuses to revoke an invite belonging to another creator', async () => {
      const { token } = (await invite(owner, 'st-other').expect(201)).body;
      const row = await ctx.prisma.staffInvite.findUniqueOrThrow({
        where: { tokenHash: sha256(token) },
      });
      await del(owner, `/creators/staff-co/staff/invites/${row.id}`).expect(404);
    });

    it('refuses a moderator listing staff', async () => {
      await get(mod, '/creators/staff-co/staff').expect(403);
    });
  });

  describe('accepting', () => {
    it('makes the accepter a moderator', async () => {
      const { token } = (await invite().expect(201)).body;
      const res = await post(stranger, '/staff/invites/accept', { token }).expect(201);
      expect(res.body).toMatchObject({
        role: 'MOD',
        permissions: ALL_STAFF_PERMISSIONS,
        creator: { slug: 'staff-co' },
      });
      expect(await roleOf(strangerUserId)).toBe('MOD');
    });

    it('consumes the invite', async () => {
      const { token } = (await invite().expect(201)).body;
      await post(stranger, '/staff/invites/accept', { token }).expect(201);
      await post(otherStranger, '/staff/invites/accept', { token }).expect(404);
    });

    it('answers identically for unknown, expired, revoked and used tokens', async () => {
      // Anything else makes the endpoint a token oracle.
      const expired = (await invite().expect(201)).body.token;
      await ctx.prisma.staffInvite.update({
        where: { tokenHash: sha256(expired) },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const revoked = (await invite().expect(201)).body.token;
      await ctx.prisma.staffInvite.update({
        where: { tokenHash: sha256(revoked) },
        data: { revokedAt: new Date() },
      });
      const used = (await invite().expect(201)).body.token;
      await post(stranger, '/staff/invites/accept', { token: used }).expect(201);

      const answers = [];
      for (const token of ['a'.repeat(43), expired, revoked, used]) {
        answers.push(await post(otherStranger, '/staff/invites/accept', { token }));
      }
      expect(new Set(answers.map((a) => a.status))).toEqual(new Set([404]));
      expect(new Set(answers.map((a) => JSON.stringify(a.body.message))).size).toBe(1);
    });

    it('refuses an anonymous accepter', async () => {
      // Consent means an authenticated action; there is nobody to appoint otherwise. Carries a
      // valid anonymous CSRF pair so the assertion is about the session guard, not the
      // middleware in front of it.
      const { token } = (await invite().expect(201)).body;
      const anon = await anonymousCsrf();
      await request(ctx.app.getHttpServer())
        .post('/api/v1/staff/invites/accept')
        .set('Cookie', [anon.csrf])
        .set('x-csrf-token', anon.csrfToken)
        .send({ token })
        .expect(401);
    });

    it('is idempotent for someone who is already staff', async () => {
      const first = (await invite().expect(201)).body.token;
      const second = (await invite().expect(201)).body.token;
      await post(stranger, '/staff/invites/accept', { token: first }).expect(201);
      await post(stranger, '/staff/invites/accept', { token: second }).expect(201);
      expect(
        await ctx.prisma.creatorStaff.count({ where: { creatorId, userId: strangerUserId } }),
      ).toBe(1);
    });

    it('does not demote an owner who accepts a mod invite', async () => {
      // The composite unique makes this an update, and an unguarded one would strip the creator
      // of their own board.
      const { token } = (await invite().expect(201)).body;
      await post(owner, '/staff/invites/accept', { token }).expect(201);
      expect(await roleOf(ownerUserId)).toBe('OWNER');
    });

    it('rejects a malformed token', async () => {
      await post(stranger, '/staff/invites/accept', { token: '' }).expect(400);
      await post(stranger, '/staff/invites/accept', {}).expect(400);
    });
  });

  describe('removing', () => {
    it('removes a moderator', async () => {
      await del(owner, `/creators/staff-co/staff/${modUserId}`).expect(204);
      expect(await roleOf(modUserId)).toBeNull();
    });

    it('revokes the removed moderator power immediately', async () => {
      // The capability is resolved per request from the row, so removal must bite at once —
      // this is the assertion that proves removal is more than a row change.
      await get(mod, '/creators/staff-co/review-queue').expect(200);
      await del(owner, `/creators/staff-co/staff/${modUserId}`).expect(204);
      await get(mod, '/creators/staff-co/review-queue').expect(403);
    });

    it('refuses to remove the creator own owner even beside a second OWNER row', async () => {
      // The guard anchors on Creator.ownerUserId, not on how many OWNER rows exist.
      await ctx.prisma.creatorStaff.create({
        data: { creatorId, userId: strangerUserId, role: 'OWNER' },
      });
      await del(owner, `/creators/staff-co/staff/${ownerUserId}`).expect(409);
      expect(await roleOf(ownerUserId)).toBe('OWNER');
    });

    it('refuses to remove the last owner', async () => {
      // Otherwise the board is unadministrable and no endpoint can fix it.
      await del(owner, `/creators/staff-co/staff/${ownerUserId}`).expect(409);
      expect(await roleOf(ownerUserId)).toBe('OWNER');
    });

    it('refuses a moderator removing anyone', async () => {
      await del(mod, `/creators/staff-co/staff/${ownerUserId}`).expect(403);
      await del(mod, `/creators/staff-co/staff/${modUserId}`).expect(403);
    });

    it('refuses to remove someone staffed on another creator only', async () => {
      await ctx.prisma.creatorStaff.create({
        data: {
          creatorId: otherCreatorId,
          userId: strangerUserId,
          role: 'MOD',
          permissions: ALL_STAFF_PERMISSIONS,
        },
      });
      await del(owner, `/creators/staff-co/staff/${strangerUserId}`).expect(404);
      expect(await roleOf(strangerUserId, otherCreatorId)).toBe('MOD');
    });

    it('404s a user who is not staff at all', async () => {
      await del(owner, `/creators/staff-co/staff/${randomUUID()}`).expect(404);
    });
  });
});
