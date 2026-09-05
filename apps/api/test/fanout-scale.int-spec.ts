import { ModerationActionsService } from '../src/moderation/moderation-actions.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import { AuthTestContext, startAuthApp } from './support/auth-app';
import { ALL_STAFF_PERMISSIONS } from '../src/access/permissions';

/**
 * What a move costs when a board has an audience.
 *
 * The other suites prove the fan-out is correct with two or three followers, which a
 * per-recipient loop satisfies just as well as a batched one. This is the suite that forbids the
 * loop — the failure it catches is invisible at every scale the rest of the tests reach, and
 * fatal at the only scale that matters.
 */
describe('Fan-out at follower scale (integration)', () => {
  let ctx: AuthTestContext;
  let notifications: NotificationsService;
  let actions: ModerationActionsService;
  let creatorId: string;
  let owner: string;
  let moderator: string;
  let recId: string;

  const FOLLOWERS = 500;

  beforeAll(async () => {
    ctx = await startAuthApp();
    notifications = ctx.app.get(NotificationsService);
    actions = ctx.app.get(ModerationActionsService);

    owner = (await ctx.prisma.user.create({ data: { patreonUserId: 'fs-owner' } })).id;
    moderator = (await ctx.prisma.user.create({ data: { patreonUserId: 'fs-mod' } })).id;
    creatorId = (
      await ctx.prisma.creator.create({
        data: {
          patreonCampaignId: 'fs-campaign',
          ownerUserId: owner,
          displayName: 'Busy Co',
          slug: 'busy-co',
          policy: { create: { viewVisibility: 'PUBLIC' } },
          staff: { create: { userId: owner, role: 'OWNER' } },
        },
      })
    ).id;
    await ctx.prisma.creatorStaff.create({
      data: { creatorId, userId: moderator, role: 'MOD', permissions: ALL_STAFF_PERMISSIONS },
    });

    await ctx.prisma.user.createMany({
      data: Array.from({ length: FOLLOWERS }, (_, i) => ({ patreonUserId: `fs-follower-${i}` })),
    });
    const followers = await ctx.prisma.user.findMany({
      where: { patreonUserId: { startsWith: 'fs-follower-' } },
      select: { id: true },
    });
    await ctx.prisma.creatorFavorite.createMany({
      data: followers.map((f) => ({ userId: f.id, creatorId })),
    });
  }, 300_000);

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.prisma.notification.deleteMany();
    await ctx.prisma.recommendation.deleteMany();
    recId = (
      await ctx.prisma.recommendation.create({
        data: {
          creatorId,
          submittedByUserId: owner,
          type: 'MOVIE',
          customTitle: 'Serial Experiments Lain',
          normalizedTitle: 'serial experiments lain',
        },
      })
    ).id;
  });

  const moveToActive = async () => {
    await actions.changeStatus(creatorId, recId, moderator, 'ACCEPTED');
    await actions.changeStatus(creatorId, recId, moderator, 'ACTIVE');
  };

  it(`reaches all ${FOLLOWERS} followers exactly once`, async () => {
    await moveToActive();

    const rows = await ctx.prisma.notification.findMany({
      where: { creatorId, type: 'ENTRY_MOVED' },
      select: { userId: true, groupCount: true },
    });
    expect(rows).toHaveLength(FOLLOWERS);
    expect(new Set(rows.map((r) => r.userId)).size).toBe(FOLLOWERS);
    expect(rows.every((r) => r.groupCount === 1)).toBe(true);
  }, 60_000);

  it('folds a second move for all of them without adding rows', async () => {
    await moveToActive();
    await actions.changeStatus(creatorId, recId, moderator, 'COMPLETED');

    const rows = await ctx.prisma.notification.findMany({
      where: { creatorId, type: 'ENTRY_MOVED' },
      select: { groupCount: true },
    });
    expect(rows).toHaveLength(FOLLOWERS);
    expect(rows.every((r) => r.groupCount === 2)).toBe(true);
  }, 60_000);

  it('finishes a move on a busy board well inside a request timeout', async () => {
    // Measured at 63ms for both moves when this was written, so the budget is roughly 150x the
    // observed cost — loose enough to survive a slow CI box, tight enough that the day this
    // becomes an outbox problem a test says so rather than a user does.
    const started = Date.now();

    await moveToActive();

    expect(Date.now() - started).toBeLessThan(10_000);
  }, 60_000);

  it('costs the same number of database calls at 500 recipients as at 5', async () => {
    // The assertion that actually forbids an N+1. Row counts pass happily with a loop; a call
    // count does not. Wall-clock timing would say the same thing far less reliably.
    const at5 = await callsToEmit(5);
    const at500 = await callsToEmit(FOLLOWERS);

    expect(at500).toBe(at5);
  }, 60_000);

  /** Counts the database calls one fan-out makes, by handing it a writer that keeps score. */
  async function callsToEmit(recipients: number): Promise<number> {
    const users = await ctx.prisma.user.findMany({
      where: { patreonUserId: { startsWith: 'fs-follower-' } },
      select: { id: true },
      take: recipients,
    });
    let calls = 0;
    const counting = {
      $executeRaw: (...args: Parameters<typeof ctx.prisma.$executeRaw>) => {
        calls += 1;
        return ctx.prisma.$executeRaw(...args);
      },
      notification: {
        findMany: (args: Parameters<typeof ctx.prisma.notification.findMany>[0]) => {
          calls += 1;
          return ctx.prisma.notification.findMany(args);
        },
        createMany: (args: Parameters<typeof ctx.prisma.notification.createMany>[0]) => {
          calls += 1;
          return ctx.prisma.notification.createMany(args);
        },
      },
    };

    await notifications.emitCoalesced(
      counting as never,
      users.map((u) => ({
        userId: u.id,
        creatorId,
        type: 'ENTRY_MOVED' as const,
        payload: {
          recommendationId: recId,
          title: 'Serial Experiments Lain',
          creatorSlug: 'busy-co',
          creatorName: 'Busy Co',
          status: 'ACTIVE' as const,
        },
      })),
    );
    await ctx.prisma.notification.deleteMany();
    return calls;
  }
});
