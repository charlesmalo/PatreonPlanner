import request from 'supertest';
import { MembershipRefreshJob } from '../src/jobs/membership-refresh.job';
import { AuthTestContext, pickCookie, startAuthApp } from './support/auth-app';

describe('MembershipRefreshJob (integration)', () => {
  let ctx: AuthTestContext;
  let job: MembershipRefreshJob;
  let creatorId: string;

  beforeAll(async () => {
    ctx = await startAuthApp();
    job = ctx.app.get(MembershipRefreshJob);
    const owner = await ctx.prisma.user.create({ data: { patreonUserId: 'refresh-owner' } });
    const creator = await ctx.prisma.creator.create({
      data: {
        patreonCampaignId: 'refresh-campaign',
        ownerUserId: owner.id,
        displayName: 'Refresh Co',
        slug: 'refresh-co',
        tiers: {
          create: [{ patreonTierId: 'r-tier', title: 'Gold', amountCents: 1000, order: 0 }],
        },
        policy: { create: {} },
      },
    });
    creatorId = creator.id;
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
  });

  async function loginAs(patreonUserId: string): Promise<string> {
    ctx.patreon.identity = { ...ctx.patreon.identity, patreonUserId, memberships: [] };
    const start = await request(ctx.app.getHttpServer()).get('/auth/patreon/login').expect(302);
    const state = new URL(start.headers.location).searchParams.get('state') as string;
    await request(ctx.app.getHttpServer())
      .get(`/auth/patreon/callback?code=auth-code&state=${state}`)
      .set('Cookie', pickCookie(start, 'pp_oauth_state'))
      .expect(302);
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { patreonUserId } });
    return user.id;
  }

  const stale = () => new Date(Date.now() - 72 * 60 * 60 * 1000);

  it('leaves a freshly synced membership alone', async () => {
    const userId = await loginAs('refresh-fresh');
    await ctx.prisma.membership.create({
      data: { userId, creatorId, amountCents: 100, isActivePatron: true },
    });
    expect(await job.runOnce()).toBe(0);
  });

  it('re-syncs a membership past the ttl and picks up a revocation', async () => {
    const userId = await loginAs('refresh-stale');
    await ctx.prisma.membership.create({
      data: {
        userId,
        creatorId,
        amountCents: 1000,
        isActivePatron: true,
        lastSyncedAt: stale(),
      },
    });
    // Patreon now reports no memberships — the webhook for this was never delivered.
    ctx.patreon.identity = { ...ctx.patreon.identity, memberships: [] };

    expect(await job.runOnce()).toBe(1);

    const membership = await ctx.prisma.membership.findUniqueOrThrow({
      where: { userId_creatorId: { userId, creatorId } },
    });
    expect(membership.isActivePatron).toBe(false);
  });

  it('does not stop on one user whose Patreon call fails', async () => {
    const brokenId = await loginAs('refresh-broken');
    await ctx.prisma.user.update({
      where: { id: brokenId },
      // No stored token, so getAccessToken throws for this user only.
      data: { accessTokenEncrypted: null, refreshTokenEncrypted: null },
    });
    await ctx.prisma.membership.create({
      data: {
        userId: brokenId,
        creatorId,
        amountCents: 1,
        isActivePatron: true,
        lastSyncedAt: stale(),
      },
    });
    const okId = await loginAs('refresh-ok');
    await ctx.prisma.membership.create({
      data: {
        userId: okId,
        creatorId,
        amountCents: 1,
        isActivePatron: true,
        lastSyncedAt: stale(),
      },
    });

    // One failure must not abandon the rest of the batch.
    expect(await job.runOnce()).toBe(1);
  });

  it('stamps an attempt even when it fails, so a broken user cannot hold the batch', async () => {
    const brokenId = await loginAs('refresh-starver');
    await ctx.prisma.user.update({
      where: { id: brokenId },
      data: { accessTokenEncrypted: null, refreshTokenEncrypted: null },
    });
    await ctx.prisma.membership.create({
      data: {
        userId: brokenId,
        creatorId,
        amountCents: 1,
        isActivePatron: true,
        lastSyncedAt: stale(),
      },
    });

    await job.runOnce();

    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { id: brokenId } });
    // Without this stamp the user stays permanently selectable and, ordered ahead of everyone
    // else, starves the whole fallback path.
    expect(user.membershipsRefreshedAt).not.toBeNull();

    // Immediately re-running must not pick them again inside the retry window.
    const before = user.membershipsRefreshedAt as Date;
    await job.runOnce();
    const after = await ctx.prisma.user.findUniqueOrThrow({ where: { id: brokenId } });
    expect(after.membershipsRefreshedAt?.getTime()).toBe(before.getTime());
  });
});
