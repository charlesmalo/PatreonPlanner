import request from 'supertest';
import { MembershipRefreshJob } from '../src/jobs/membership-refresh.job';
import { AuthTestContext, pickCookie, startAuthApp } from './support/auth-app';

describe('Tier re-sync (integration)', () => {
  let ctx: AuthTestContext;
  let job: MembershipRefreshJob;
  let creatorId: string;

  beforeAll(async () => {
    ctx = await startAuthApp();
    job = ctx.app.get(MembershipRefreshJob);

    // The owner needs a stored token, so log them in rather than inserting a bare row.
    ctx.patreon.identity = {
      ...ctx.patreon.identity,
      patreonUserId: 'tier-owner',
      memberships: [],
    };
    const start = await request(ctx.app.getHttpServer()).get('/auth/patreon/login').expect(302);
    const state = new URL(start.headers.location).searchParams.get('state') as string;
    await request(ctx.app.getHttpServer())
      .get(`/auth/patreon/callback?code=auth-code&state=${state}`)
      .set('Cookie', pickCookie(start, 'pp_oauth_state'))
      .expect(302);
    const owner = await ctx.prisma.user.findUniqueOrThrow({
      where: { patreonUserId: 'tier-owner' },
    });

    const creator = await ctx.prisma.creator.create({
      data: {
        patreonCampaignId: 'tier-campaign',
        ownerUserId: owner.id,
        displayName: 'Tier Co',
        slug: 'tier-co',
        tiers: {
          create: [{ patreonTierId: 't-lo', title: 'Bronze', amountCents: 300, order: 0 }],
        },
        policy: { create: { viewVisibility: 'PUBLIC' } },
      },
    });
    creatorId = creator.id;
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
  });

  /** Tier re-sync only revisits a creator once a day, so tests make theirs due first. */
  async function makeDue() {
    await ctx.prisma.creator.update({
      where: { id: creatorId },
      data: { tiersSyncedAt: null },
    });
  }

  beforeEach(async () => {
    await makeDue();
  });

  it('imports a tier added on Patreon after the claim', async () => {
    ctx.patreon.campaigns = [
      {
        campaignId: 'tier-campaign',
        displayName: 'Tier Co',
        tiers: [
          { patreonTierId: 't-lo', title: 'Bronze', amountCents: 300, order: 0 },
          { patreonTierId: 't-hi', title: 'Platinum', amountCents: 5000, order: 1 },
        ],
      },
    ];

    expect(await job.resyncTiers()).toBe(1);

    const tiers = await ctx.prisma.tier.findMany({
      where: { creatorId },
      orderBy: { amountCents: 'asc' },
    });
    expect(tiers.map((t) => t.patreonTierId)).toEqual(['t-lo', 't-hi']);
  });

  it('updates a tier whose price changed', async () => {
    ctx.patreon.campaigns = [
      {
        campaignId: 'tier-campaign',
        displayName: 'Tier Co',
        tiers: [{ patreonTierId: 't-lo', title: 'Bronze', amountCents: 400, order: 0 }],
      },
    ];
    await job.resyncTiers();
    const tier = await ctx.prisma.tier.findFirstOrThrow({
      where: { creatorId, patreonTierId: 't-lo' },
    });
    expect(tier.amountCents).toBe(400);
  });

  it('keeps a tier that disappeared from Patreon rather than deleting it', async () => {
    ctx.patreon.campaigns = [{ campaignId: 'tier-campaign', displayName: 'Tier Co', tiers: [] }];
    await job.resyncTiers();
    // Deleting would fail against a policy gate (Restrict) or silently widen it.
    expect(await ctx.prisma.tier.count({ where: { creatorId } })).toBeGreaterThan(0);
  });

  it('skips a creator that was re-synced recently', async () => {
    ctx.patreon.campaigns = [
      {
        campaignId: 'tier-campaign',
        displayName: 'Tier Co',
        tiers: [{ patreonTierId: 't-lo', title: 'Bronze', amountCents: 400, order: 0 }],
      },
    ];
    await ctx.prisma.creator.update({
      where: { id: creatorId },
      data: { tiersSyncedAt: new Date() },
    });
    // Tiers change monthly; re-reading every creator every tick would be 96 Patreon calls each
    // per day, and would starve creator N+1 entirely.
    expect(await job.resyncTiers()).toBe(0);
  });

  it('skips a creator whose owner token is gone rather than failing the batch', async () => {
    const owner = await ctx.prisma.user.findUniqueOrThrow({
      where: { patreonUserId: 'tier-owner' },
    });
    await ctx.prisma.user.update({
      where: { id: owner.id },
      data: { accessTokenEncrypted: null, refreshTokenEncrypted: null },
    });
    ctx.patreon.campaigns = [];
    expect(await job.resyncTiers()).toBe(0);
  });
});
