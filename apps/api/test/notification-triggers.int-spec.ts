import { FlagsService } from '../src/moderation/flags.service';
import { ModerationActionsService } from '../src/moderation/moderation-actions.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import { StaffService } from '../src/staff/staff.service';
import { AuthTestContext, startAuthApp } from './support/auth-app';
import { ALL_STAFF_PERMISSIONS } from '../src/access/permissions';

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
          // Claiming a board writes an OWNER staff row, so a fixture without one is a board the
          // app cannot produce — and it made the owner union in the fan-out look load-bearing.
          staff: { create: { userId: owner, role: 'OWNER' } },
        },
      })
    ).id;
    await ctx.prisma.creatorStaff.create({
      data: { creatorId, userId: moderator, role: 'MOD', permissions: ALL_STAFF_PERMISSIONS },
    });
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
      let seenInside = -1;
      const rollingBack = {
        recommendation: ctx.prisma.recommendation,
        $transaction: (fn: (tx: typeof ctx.prisma) => Promise<unknown>) =>
          ctx.prisma.$transaction(async (tx) => {
            await fn(tx as typeof ctx.prisma);
            // Asked through the transaction itself. Checking only that the row is absent after a
            // rollback is not enough: an implementation that emits *after* the transaction also
            // leaves nothing behind when the transaction throws, so that assertion alone passes
            // for the very implementation this test exists to reject.
            seenInside = await tx.notification.count({ where: { userId: patron } });
            throw new Error('failed after the work was done');
          }),
      };
      const service = new ModerationActionsService(rollingBack as never, notifications);

      await expect(service.changeStatus(creatorId, recId, moderator, 'ACCEPTED')).rejects.toThrow(
        'failed after the work',
      );

      expect(seenInside).toBe(1);
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

    it('does not repeat itself while the last report is still unread', async () => {
      // Raising a flag costs a signed-in account almost nothing, and there are as many entries to
      // flag as the board has. Without coalescing, one patron puts a notification per entry in
      // front of every moderator; the review queue is where reports are actually read.
      const second = await submit(patron, 'Another Entry');
      await flags.raise(creatorId, recId, patron, 'SPAM');
      await flags.raise(creatorId, second.id, patron, 'SPAM');

      expect(await notifications.unreadCount(moderator)).toBe(1);

      // ...and once they have looked, the next report reaches them again.
      await notifications.markRead(moderator);
      const third = await submit(patron, 'A Third');
      await flags.raise(creatorId, third.id, patron, 'SPAM');
      expect(await notifications.unreadCount(moderator)).toBe(1);
    });

    it('stops showing a removed moderator what they can no longer see', async () => {
      const staff = ctx.app.get(StaffService);
      const leaving = await ctx.prisma.user.create({ data: { patreonUserId: 'tg-leaving' } });
      await ctx.prisma.creatorStaff.create({
        data: { creatorId, userId: leaving.id, role: 'MOD', permissions: ALL_STAFF_PERMISSIONS },
      });
      await flags.raise(creatorId, recId, patron, 'SPAM');
      expect(await notifications.unreadCount(leaving.id)).toBe(1);

      await staff.removeMember(creatorId, leaving.id);

      // The payload carries the entry title and why it was reported. On a subscribers-only board
      // an ex-mod who does not pledge cannot read a single entry, so leaving these in their bell
      // outlives the role that entitled them to them.
      expect(await notifications.unreadCount(leaving.id)).toBe(0);
    });

    it('tells no one who moderates a different board', async () => {
      // The recipient here is staff — just not staff *here*. An earlier version of this test used
      // a user with no staff row anywhere, which an unscoped query satisfies just as well, so it
      // held nothing down.
      const elsewhere = await ctx.prisma.user.create({ data: { patreonUserId: 'tg-elsewhere' } });
      const otherCreator = await ctx.prisma.creator.create({
        data: {
          patreonCampaignId: 'tg-other',
          ownerUserId: elsewhere.id,
          displayName: 'Other',
          slug: 'tg-other',
          policy: { create: {} },
          staff: { create: { userId: elsewhere.id, role: 'OWNER' } },
        },
      });
      const theirMod = await ctx.prisma.user.create({ data: { patreonUserId: 'tg-their-mod' } });
      await ctx.prisma.creatorStaff.create({
        data: {
          creatorId: otherCreator.id,
          userId: theirMod.id,
          role: 'MOD',
          permissions: ALL_STAFF_PERMISSIONS,
        },
      });

      await flags.raise(creatorId, recId, patron, 'SPAM');

      expect(await notifications.unreadCount(theirMod.id)).toBe(0);
      expect(await notifications.unreadCount(elsewhere.id)).toBe(0);
      await ctx.prisma.creator.delete({ where: { id: otherCreator.id } });
    });
  });
});
