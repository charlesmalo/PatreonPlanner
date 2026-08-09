import request from 'supertest';
import { AuthTestContext, pickCookie, startAuthApp } from './support/auth-app';

describe('Creator read and policy endpoints (integration)', () => {
  let ctx: AuthTestContext;
  let creatorId: string;
  let tierIds: { lo: string; hi: string };

  beforeAll(async () => {
    ctx = await startAuthApp();
    const owner = await ctx.prisma.user.create({ data: { patreonUserId: 'policy-owner' } });
    const creator = await ctx.prisma.creator.create({
      data: {
        patreonCampaignId: 'policy-campaign',
        ownerUserId: owner.id,
        displayName: 'Policy Co',
        slug: 'policy-co',
        baseUrl: 'https://policy.example.com',
        tiers: {
          create: [
            { patreonTierId: 'p-lo', title: 'Bronze', amountCents: 300, order: 0 },
            { patreonTierId: 'p-hi', title: 'Gold', amountCents: 1000, order: 1 },
          ],
        },
        policy: { create: {} },
      },
      include: { tiers: true },
    });
    creatorId = creator.id;
    tierIds = {
      lo: creator.tiers.find((t) => t.amountCents === 300)!.id,
      hi: creator.tiers.find((t) => t.amountCents === 1000)!.id,
    };
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
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

  async function makeStaff(patreonUserId: string) {
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { patreonUserId } });
    await ctx.prisma.creatorStaff.upsert({
      where: { creatorId_userId: { creatorId, userId: user.id } },
      create: { creatorId, userId: user.id, role: 'OWNER' },
      update: {},
    });
  }

  it('exposes the public creator profile without a login', async () => {
    const res = await request(ctx.app.getHttpServer())
      .get('/api/v1/creators/policy-co')
      .expect(200);
    expect(res.body).toEqual({
      id: creatorId,
      slug: 'policy-co',
      displayName: 'Policy Co',
      baseUrl: 'https://policy.example.com',
      tiers: [
        { id: tierIds.lo, title: 'Bronze', amountCents: 300, order: 0 },
        { id: tierIds.hi, title: 'Gold', amountCents: 1000, order: 1 },
      ],
    });
  });

  it('never exposes the owner or the patreon campaign id publicly', async () => {
    const res = await request(ctx.app.getHttpServer()).get('/api/v1/creators/policy-co');
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('ownerUserId');
    expect(body).not.toContain('policy-campaign');
  });

  it('refuses policy reads to a non-staff user', async () => {
    const auth = await loginAs('policy-stranger');
    await request(ctx.app.getHttpServer())
      .get(`/api/v1/creators/${creatorId}/policy`)
      .set('Cookie', auth.session)
      .expect(403);
  });

  it('lets staff read the policy', async () => {
    const auth = await loginAs('policy-staff');
    await makeStaff('policy-staff');
    const res = await request(ctx.app.getHttpServer())
      .get(`/api/v1/creators/${creatorId}/policy`)
      .set('Cookie', auth.session)
      .expect(200);
    expect(res.body.viewVisibility).toBe('PUBLIC');
  });

  it('lets staff update the policy', async () => {
    const auth = await loginAs('policy-staff-2');
    await makeStaff('policy-staff-2');
    const res = await request(ctx.app.getHttpServer())
      .patch(`/api/v1/creators/${creatorId}/policy`)
      .set('Cookie', [auth.session, auth.csrf])
      .set('x-csrf-token', auth.csrfToken)
      .send({ viewVisibility: 'SUBSCRIBERS_ONLY', submitMinTierId: tierIds.hi })
      .expect(200);
    expect(res.body.viewVisibility).toBe('SUBSCRIBERS_ONLY');
    expect(res.body.submitMinTierId).toBe(tierIds.hi);

    // Restore, so ordering between tests cannot lock the suite out of its own fixture.
    await ctx.prisma.creatorPolicy.update({
      where: { creatorId },
      data: { viewVisibility: 'PUBLIC', submitMinTierId: null },
    });
  });

  it('rejects a policy update without a csrf token', async () => {
    const auth = await loginAs('policy-staff-3');
    await makeStaff('policy-staff-3');
    await request(ctx.app.getHttpServer())
      .patch(`/api/v1/creators/${creatorId}/policy`)
      .set('Cookie', auth.session)
      .send({ viewVisibility: 'PUBLIC' })
      .expect(403);
  });

  it('rejects an unknown visibility value', async () => {
    const auth = await loginAs('policy-staff-5');
    await makeStaff('policy-staff-5');
    await request(ctx.app.getHttpServer())
      .patch(`/api/v1/creators/${creatorId}/policy`)
      .set('Cookie', [auth.session, auth.csrf])
      .set('x-csrf-token', auth.csrfToken)
      .send({ viewVisibility: 'EVERYONE' })
      .expect(400);
  });

  it('refuses a tier belonging to another creator', async () => {
    const auth = await loginAs('policy-staff-4');
    await makeStaff('policy-staff-4');
    const stranger = await ctx.prisma.user.create({ data: { patreonUserId: 'tier-thief' } });
    const otherCreator = await ctx.prisma.creator.create({
      data: {
        patreonCampaignId: 'thief-campaign',
        ownerUserId: stranger.id,
        displayName: 'Thief',
        slug: 'thief',
        tiers: { create: [{ patreonTierId: 't-1', title: 'T', amountCents: 100, order: 0 }] },
      },
      include: { tiers: true },
    });
    // Otherwise a creator could gate their board on a tier nobody pledging to them can hold.
    await request(ctx.app.getHttpServer())
      .patch(`/api/v1/creators/${creatorId}/policy`)
      .set('Cookie', [auth.session, auth.csrf])
      .set('x-csrf-token', auth.csrfToken)
      .send({ submitMinTierId: otherCreator.tiers[0].id })
      .expect(400);
  });
});
