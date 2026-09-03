import { MembershipSyncService } from '../src/memberships/membership-sync.service';
import { AuthTestContext, startAuthApp } from './support/auth-app';

describe('MembershipSyncService (integration)', () => {
  let ctx: AuthTestContext;
  let sync: MembershipSyncService;
  let creatorId: string;
  let otherCreatorId: string;
  let tierId: string;
  let userId: string;

  beforeAll(async () => {
    ctx = await startAuthApp();
    sync = ctx.app.get(MembershipSyncService);

    const owner = await ctx.prisma.user.create({ data: { patreonUserId: 'sync-owner' } });
    const creator = await ctx.prisma.creator.create({
      data: {
        patreonCampaignId: 'sync-campaign',
        ownerUserId: owner.id,
        displayName: 'Sync Co',
        slug: 'sync-co',
        tiers: {
          create: [{ patreonTierId: 's-tier', title: 'Gold', amountCents: 1000, order: 0 }],
        },
        policy: { create: {} },
      },
      include: { tiers: true },
    });
    creatorId = creator.id;
    tierId = creator.tiers[0].id;

    const other = await ctx.prisma.creator.create({
      data: {
        patreonCampaignId: 'other-sync-campaign',
        ownerUserId: owner.id,
        displayName: 'Other Sync',
        slug: 'other-sync',
        policy: { create: {} },
      },
    });
    otherCreatorId = other.id;

    const user = await ctx.prisma.user.create({ data: { patreonUserId: 'sync-user' } });
    userId = user.id;
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
  });

  it('creates a membership for a claimed campaign', async () => {
    await sync.applyIdentity(userId, [
      {
        campaignId: 'sync-campaign',
        patreonTierIds: ['s-tier'],
        amountCents: 1000,
        isActivePatron: true,
      },
    ]);
    const membership = await ctx.prisma.membership.findUniqueOrThrow({
      where: { userId_creatorId: { userId, creatorId } },
    });
    expect(membership.isActivePatron).toBe(true);
    expect(membership.amountCents).toBe(1000);
    expect(membership.currentTierId).toBe(tierId);
  });

  it('skips a campaign nobody has claimed', async () => {
    await sync.applyIdentity(userId, [
      {
        campaignId: 'unclaimed-campaign',
        patreonTierIds: [],
        amountCents: 500,
        isActivePatron: true,
      },
    ]);
    expect(await ctx.prisma.membership.count({ where: { userId } })).toBe(1);
  });

  it('deactivates a membership absent from the payload', async () => {
    await sync.applyIdentity(userId, []);
    const membership = await ctx.prisma.membership.findUniqueOrThrow({
      where: { userId_creatorId: { userId, creatorId } },
    });
    expect(membership.isActivePatron).toBe(false);
    expect(membership.currentTierId).toBeNull();
  });

  it('advances lastSyncedAt even when nothing changed', async () => {
    const before = await ctx.prisma.membership.findUniqueOrThrow({
      where: { userId_creatorId: { userId, creatorId } },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await sync.applyIdentity(userId, []);
    const after = await ctx.prisma.membership.findUniqueOrThrow({
      where: { userId_creatorId: { userId, creatorId } },
    });
    // The staleness job selects on this column; leaving it behind would re-sync forever.
    expect(after.lastSyncedAt.getTime()).toBeGreaterThan(before.lastSyncedAt.getTime());
  });

  it('leaves other creators alone when scoped to one campaign', async () => {
    // Both active to begin with.
    await sync.applyIdentity(userId, [
      {
        campaignId: 'sync-campaign',
        patreonTierIds: [],
        amountCents: 100,
        isActivePatron: true,
      },
      {
        campaignId: 'other-sync-campaign',
        patreonTierIds: [],
        amountCents: 200,
        isActivePatron: true,
      },
    ]);

    // A webhook speaks for one campaign. Unscoped, this payload would revoke the other one.
    await sync.applyIdentity(userId, [], { onlyCampaignIds: ['sync-campaign'] });

    const scoped = await ctx.prisma.membership.findUniqueOrThrow({
      where: { userId_creatorId: { userId, creatorId } },
    });
    const untouched = await ctx.prisma.membership.findUniqueOrThrow({
      where: { userId_creatorId: { userId, creatorId: otherCreatorId } },
    });
    expect(scoped.isActivePatron).toBe(false);
    expect(untouched.isActivePatron).toBe(true);
  });

  /**
   * A sync that saw only part of the picture must not report the whole thing settled.
   *
   * `membershipsSyncPending` means "we still owe this reader a full read of what they support".
   * A webhook speaks for one campaign, so clearing on that would call the debt paid on the
   * strength of a partial view — the same distinction `deactivateAbsent` draws when it refuses to
   * deactivate outside the campaigns it was told about.
   */
  describe('an outstanding membership sync', () => {
    beforeEach(async () => {
      await ctx.prisma.user.update({
        where: { id: userId },
        data: { membershipsSyncPending: true },
      });
    });

    it('is settled by a sync that saw everything', async () => {
      await sync.applyIdentity(userId, []);

      const user = await ctx.prisma.user.findUniqueOrThrow({ where: { id: userId } });
      expect(user.membershipsSyncPending).toBe(false);
    });

    it('is not settled by a webhook speaking for one campaign', async () => {
      await sync.applyIdentity(userId, [], { onlyCampaignIds: ['campaign-known'] });

      const user = await ctx.prisma.user.findUniqueOrThrow({ where: { id: userId } });
      expect(user.membershipsSyncPending).toBe(true);
    });
  });
});
