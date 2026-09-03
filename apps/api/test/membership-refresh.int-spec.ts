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

  /**
   * The reader a stale Membership row cannot speak for.
   *
   * Somebody whose first login could not read their memberships has none at all, so the ordinary
   * selector — "has a membership older than the ttl" — never sees them. Without the flag they
   * would sign in once and never be given access to anything they pay for.
   */
  describe('a reader who owes a sync but has no memberships yet', () => {
    /**
     * Signed in for real, then marked as owing a sync — which is exactly how they arise. Created
     * directly they would have no stored tokens, so the job would skip them at `getAccessToken`
     * and every assertion below would pass or fail for that reason instead of its own.
     */
    const newcomer = async () => {
      const patreonUserId = `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const id = await loginAs(patreonUserId);
      return ctx.prisma.user.update({
        where: { id },
        // The refresh stamp goes back to null too, as the login fallback leaves it — otherwise
        // the back-off would hold them out of this very batch.
        data: { membershipsSyncPending: true, membershipsRefreshedAt: null },
      });
    };

    it('is picked up even though nothing of theirs is stale', async () => {
      const user = await newcomer();
      ctx.patreon.identity = {
        ...ctx.patreon.identity,
        patreonUserId: user.patreonUserId,
        memberships: [
          {
            campaignId: 'refresh-campaign',
            patreonTierIds: ['r-tier'],
            amountCents: 1000,
            isActivePatron: true,
          },
        ],
      };

      await job.runOnce();

      const membership = await ctx.prisma.membership.findFirst({ where: { userId: user.id } });
      expect(membership?.isActivePatron).toBe(true);
    });

    it('stops owing one once it succeeds', async () => {
      const user = await newcomer();
      ctx.patreon.identity = {
        ...ctx.patreon.identity,
        patreonUserId: user.patreonUserId,
        memberships: [],
      };

      await job.runOnce();

      const after = await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(after.membershipsSyncPending).toBe(false);
    });

    it('keeps owing one when Patreon still will not answer', async () => {
      // Otherwise a single failed attempt would clear the debt and strand them for good.
      const user = await newcomer();
      ctx.patreon.identityShouldFail = true;

      await job.runOnce();

      const after = await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(after.membershipsSyncPending).toBe(true);
      ctx.patreon.identityShouldFail = false;
    });

    it('is not re-asked about immediately after an attempt', async () => {
      // The flag must not defeat the back-off. A reader Patreon cannot answer for would
      // otherwise fill every batch forever and starve everybody behind them.
      const user = await newcomer();
      ctx.patreon.identityShouldFail = true;
      await job.runOnce();

      // Patreon recovers, but it is too soon to ask again. Asserted through what the second run
      // *does* rather than by comparing stamps: two runs land within the same millisecond, so a
      // timestamp comparison passes whether the back-off holds or not.
      ctx.patreon.identityShouldFail = false;
      ctx.patreon.identity = {
        ...ctx.patreon.identity,
        patreonUserId: user.patreonUserId,
        memberships: [
          {
            campaignId: 'refresh-campaign',
            patreonTierIds: ['r-tier'],
            amountCents: 1000,
            isActivePatron: true,
          },
        ],
      };

      await job.runOnce();

      // Nothing applied, because they were never in the batch.
      expect(await ctx.prisma.membership.count({ where: { userId: user.id } })).toBe(0);
      const after = await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(after.membershipsSyncPending).toBe(true);
    });
  });
});
