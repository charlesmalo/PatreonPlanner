import request from 'supertest';
import { AuthTestContext, pickCookie, startAuthApp } from './support/auth-app';

describe('CreatorAccessGuard (integration)', () => {
  let ctx: AuthTestContext;
  let creatorId: string;

  beforeAll(async () => {
    ctx = await startAuthApp();
    const owner = await ctx.prisma.user.create({ data: { patreonUserId: 'guard-owner' } });
    const creator = await ctx.prisma.creator.create({
      data: {
        patreonCampaignId: 'guard-campaign',
        ownerUserId: owner.id,
        displayName: 'Guarded',
        slug: 'guarded',
        tiers: {
          create: [
            { patreonTierId: 'g-lo', title: 'Bronze', amountCents: 300, order: 0 },
            { patreonTierId: 'g-hi', title: 'Gold', amountCents: 1000, order: 1 },
          ],
        },
        policy: { create: {} },
      },
    });
    creatorId = creator.id;
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
  });

  async function setVisibility(value: 'PUBLIC' | 'ANY_PATREON_USER' | 'SUBSCRIBERS_ONLY') {
    await ctx.prisma.creatorPolicy.update({
      where: { creatorId },
      data: { viewVisibility: value },
    });
  }

  async function loginAs(patreonUserId: string): Promise<string> {
    ctx.patreon.identity = { ...ctx.patreon.identity, patreonUserId, memberships: [] };
    const start = await request(ctx.app.getHttpServer()).get('/auth/patreon/login').expect(302);
    const state = new URL(start.headers.location).searchParams.get('state') as string;
    const res = await request(ctx.app.getHttpServer())
      .get(`/auth/patreon/callback?code=auth-code&state=${state}`)
      .set('Cookie', pickCookie(start, 'pp_oauth_state'))
      .expect(302);
    return pickCookie(res, 'pp_session');
  }

  async function makePatron(patreonUserId: string, amountCents: number) {
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { patreonUserId } });
    const tier = await ctx.prisma.tier.findFirstOrThrow({ where: { creatorId, amountCents } });
    await ctx.prisma.membership.upsert({
      where: { userId_creatorId: { userId: user.id, creatorId } },
      create: {
        userId: user.id,
        creatorId,
        currentTierId: tier.id,
        amountCents,
        isActivePatron: true,
      },
      update: { currentTierId: tier.id, amountCents, isActivePatron: true },
    });
  }

  const get = (cookie?: string) => {
    const req = request(ctx.app.getHttpServer()).get('/api/v1/creators/guarded');
    return cookie ? req.set('Cookie', cookie) : req;
  };

  it('404s for a creator that does not exist', async () => {
    await request(ctx.app.getHttpServer()).get('/api/v1/creators/nope').expect(404);
  });

  it('lets anyone read a PUBLIC creator', async () => {
    await setVisibility('PUBLIC');
    await get().expect(200);
  });

  it('401s an anonymous caller when a login is required', async () => {
    await setVisibility('ANY_PATREON_USER');
    // 401, not 403: the caller can fix this by logging in.
    await get().expect(401);
  });

  it('lets any logged-in user read an ANY_PATREON_USER creator', async () => {
    await setVisibility('ANY_PATREON_USER');
    await get(await loginAs('guard-user-1')).expect(200);
  });

  it('403s a logged-in non-patron when a pledge is required', async () => {
    await setVisibility('SUBSCRIBERS_ONLY');
    // 403, not 401: they are authenticated and still not entitled.
    await get(await loginAs('guard-user-2')).expect(403);
  });

  it('lets an active patron read a SUBSCRIBERS_ONLY creator', async () => {
    await setVisibility('SUBSCRIBERS_ONLY');
    const cookie = await loginAs('guard-user-3');
    await makePatron('guard-user-3', 300);
    await get(cookie).expect(200);
  });

  it('stops honouring a membership once it lapses', async () => {
    await setVisibility('SUBSCRIBERS_ONLY');
    const cookie = await loginAs('guard-user-4');
    await makePatron('guard-user-4', 300);
    await get(cookie).expect(200);

    const user = await ctx.prisma.user.findUniqueOrThrow({
      where: { patreonUserId: 'guard-user-4' },
    });
    await ctx.prisma.membership.update({
      where: { userId_creatorId: { userId: user.id, creatorId } },
      data: { isActivePatron: false },
    });
    await get(cookie).expect(403);
  });

  it('lets staff read a SUBSCRIBERS_ONLY creator without pledging', async () => {
    await setVisibility('SUBSCRIBERS_ONLY');
    const cookie = await loginAs('guard-staff');
    const user = await ctx.prisma.user.findUniqueOrThrow({
      where: { patreonUserId: 'guard-staff' },
    });
    await ctx.prisma.creatorStaff.create({ data: { creatorId, userId: user.id, role: 'MOD' } });
    await get(cookie).expect(200);
  });

  it('does not leak a membership across creators', async () => {
    await setVisibility('SUBSCRIBERS_ONLY');
    const other = await ctx.prisma.user.create({ data: { patreonUserId: 'guard-other-owner' } });
    const otherCreator = await ctx.prisma.creator.create({
      data: {
        patreonCampaignId: 'other-campaign',
        ownerUserId: other.id,
        displayName: 'Other',
        slug: 'other',
        policy: { create: {} },
      },
    });
    const cookie = await loginAs('guard-user-5');
    const user = await ctx.prisma.user.findUniqueOrThrow({
      where: { patreonUserId: 'guard-user-5' },
    });
    // A pledge to a different creator must not unlock this one.
    await ctx.prisma.membership.create({
      data: {
        userId: user.id,
        creatorId: otherCreator.id,
        amountCents: 10_000,
        isActivePatron: true,
      },
    });
    await get(cookie).expect(403);
  });

  it('does not honour a session whose user was deleted', async () => {
    await setVisibility('ANY_PATREON_USER');
    const cookie = await loginAs('guard-user-6');
    await ctx.prisma.user.deleteMany({ where: { patreonUserId: 'guard-user-6' } });
    // The session resolves, but the viewer is no longer a real user.
    await get(cookie).expect(401);
  });
});
