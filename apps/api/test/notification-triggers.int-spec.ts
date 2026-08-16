import { FlagsService } from '../src/moderation/flags.service';
import { ModerationActionsService } from '../src/moderation/moderation-actions.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import { AuthTestContext, startAuthApp } from './support/auth-app';

describe('Notification triggers (integration)', () => {
  let ctx: AuthTestContext;
  let notifications: NotificationsService;
  let actions: ModerationActionsService;
  let flags: FlagsService;
  let creatorId: string;
  let owner: string;
  let moderator: string;
  let patron: string;
  let recId: string;

  beforeAll(async () => {
    ctx = await startAuthApp();
    notifications = ctx.app.get(NotificationsService);
    actions = ctx.app.get(ModerationActionsService);
    flags = ctx.app.get(FlagsService);

    owner = (await ctx.prisma.user.create({ data: { patreonUserId: 'tg-owner' } })).id;
    moderator = (await ctx.prisma.user.create({ data: { patreonUserId: 'tg-mod' } })).id;
    patron = (await ctx.prisma.user.create({ data: { patreonUserId: 'tg-patron' } })).id;
    creatorId = (
      await ctx.prisma.creator.create({
        data: {
          patreonCampaignId: 'tg-campaign',
          ownerUserId: owner,
          displayName: 'Trigger Co',
          slug: 'trigger-co',
          policy: { create: {} },
        },
      })
    ).id;
    await ctx.prisma.creatorStaff.create({ data: { creatorId, userId: moderator, role: 'MOD' } });
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.prisma.notification.deleteMany();
    await ctx.prisma.flag.deleteMany();
    await ctx.prisma.moderationAction.deleteMany();
    await ctx.prisma.recommendation.deleteMany();
    recId = (await submit(patron, 'Cowboy Bebop')).id;
  });

  const submit = (userId: string, title: string) =>
    ctx.prisma.recommendation.create({
      data: {
        creatorId,
        submittedByUserId: userId,
        type: 'MOVIE',
        customTitle: title,
        normalizedTitle: title.toLowerCase(),
      },
    });

  describe('a status change', () => {
    it('tells the submitter, with enough detail to outlive the entry', async () => {
      await actions.changeStatus(creatorId, recId, moderator, 'ACCEPTED');

      const { items } = await notifications.list(patron);
      expect(items).toHaveLength(1);
      expect(items[0].type).toBe('ENTRY_STATUS_CHANGED');
      expect(items[0].payload).toMatchObject({
        recommendationId: recId,
        title: 'Cowboy Bebop',
        status: 'ACCEPTED',
        creatorSlug: 'trigger-co',
      });

      // The whole point of the snapshot: the message still reads correctly afterwards.
      await ctx.prisma.recommendation.delete({ where: { id: recId } });
      expect((await notifications.list(patron)).items[0].payload).toMatchObject({
        title: 'Cowboy Bebop',
      });
    });

    it('says nothing when a moderator moves their own entry', async () => {
      const own = await submit(moderator, 'Their Own Pick');

      await actions.changeStatus(creatorId, own.id, moderator, 'ACCEPTED');

      expect(await notifications.unreadCount(moderator)).toBe(0);
    });

    it('writes nothing when the transition is refused', async () => {
      // Emitted inside the transaction, so a rejected move leaves no notification claiming it
      // happened. Emitting after the fact is exactly how that lie appears.
      await expect(
        actions.changeStatus(creatorId, recId, moderator, 'COMPLETED'),
      ).rejects.toThrow();

      expect(await notifications.unreadCount(patron)).toBe(0);
    });

    it('writes nothing if the transaction it rides in rolls back', async () => {
      // The property that matters, and the one an "emit after the write" implementation fails:
      // a notification telling a patron their entry was accepted, when the move it describes was
      // rolled back, is worse than no notification. The rollback is forced rather than raced —
      // the work runs, then the transaction fails, exactly as a commit-time error would.
      const rollingBack = {
        recommendation: ctx.prisma.recommendation,
        $transaction: (fn: (tx: unknown) => Promise<unknown>) =>
          ctx.prisma.$transaction(async (tx) => {
            await fn(tx);
            throw new Error('failed after the work was done');
          }),
      };
      const service = new ModerationActionsService(rollingBack as never, notifications);

      await expect(service.changeStatus(creatorId, recId, moderator, 'ACCEPTED')).rejects.toThrow(
        'failed after the work',
      );

      expect(await notifications.unreadCount(patron)).toBe(0);
      // And nothing else survived either, so the notification is not being singled out.
      expect(
        (await ctx.prisma.recommendation.findUniqueOrThrow({ where: { id: recId } })).status,
      ).toBe('PENDING');
    });
  });

  describe('a raised flag', () => {
    it('tells the owner and every mod, but not the reporter', async () => {
      await flags.raise(creatorId, recId, patron, 'SPAM');

      expect(await notifications.unreadCount(owner)).toBe(1);
      expect(await notifications.unreadCount(moderator)).toBe(1);
      expect(await notifications.unreadCount(patron)).toBe(0);
      const { items } = await notifications.list(owner);
      expect(items[0].type).toBe('ENTRY_FLAGGED');
      expect(items[0].payload).toMatchObject({ title: 'Cowboy Bebop', reason: 'SPAM' });
    });

    it('does not tell a moderator about their own report', async () => {
      await flags.raise(creatorId, recId, moderator, 'SPAM');

      expect(await notifications.unreadCount(moderator)).toBe(0);
      expect(await notifications.unreadCount(owner)).toBe(1);
    });

    it('does not notify twice for a repeated report', async () => {
      // A repeat report returns the standing flag rather than erroring, and a second round of
      // notifications would let one reporter ring the bell as often as they liked.
      await flags.raise(creatorId, recId, patron, 'SPAM');
      await flags.raise(creatorId, recId, patron, 'SPAM');

      expect(await notifications.unreadCount(owner)).toBe(1);
    });

    it('keeps one board reports out of another board notifications', async () => {
      const other = await ctx.prisma.user.create({ data: { patreonUserId: 'tg-outsider' } });
      const otherCreator = await ctx.prisma.creator.create({
        data: {
          patreonCampaignId: 'tg-other',
          ownerUserId: other.id,
          displayName: 'Other',
          slug: 'tg-other',
          policy: { create: {} },
        },
      });

      await flags.raise(creatorId, recId, patron, 'SPAM');

      expect(await notifications.unreadCount(other.id)).toBe(0);
      await ctx.prisma.creator.delete({ where: { id: otherCreator.id } });
    });
  });
});
